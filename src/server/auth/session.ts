import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, schema } from "@/db";
import { hmac, newToken, randomId, safeEqual, sha256 } from "../crypto";
import { env } from "@/lib/env";
import { hasActiveTotp } from "./totp";
import { AppError } from "../errors";
import { can, type Membership, type Permission } from "../rbac";
import type { RequestContext } from "../audit";

export const SESSION_COOKIE = "bes_session";
export const CSRF_COOKIE = "bes_csrf";

export type AuthContext = {
  sessionId: string;
  csrfToken: string;
  user: { id: string; email: string; username: string | null; name: string; locale: string; isSuperAdmin: boolean; hasTotp: boolean };
  organisationId: string;
  membership: Membership;
  elevated: boolean;
};

const sessionHash = (t: string) => hmac(env().SESSION_SECRET, t);
const secure = () => env().APP_URL.startsWith("https://");

export async function createSession(userId: string, orgId: string | null, ctx: RequestContext, hours: number) {
  const { token } = newToken();
  const csrf = randomId(24);
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  const [s] = await db.insert(schema.sessions).values({
    userId, activeOrganisationId: orgId, tokenHash: sessionHash(token), csrfToken: csrf, ip: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null, expiresAt,
  }).returning({ id: schema.sessions.id });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", expires: expiresAt });
  // Double-submit CSRF token: readable by our JS, compared to the server-side copy on every mutation.
  jar.set(CSRF_COOKIE, csrf, { httpOnly: false, secure: secure(), sameSite: "lax", path: "/", expires: expiresAt });
  return { id: s!.id, csrf };
}

export async function destroySession() {
  const jar = await cookies();
  const t = jar.get(SESSION_COOKIE)?.value;
  if (t) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sessionHash(t)));
  jar.delete(SESSION_COOKIE); jar.delete(CSRF_COOKIE);
}

/** Resolve the session from the cookie. Membership is re-read from the DB on every request (never cached in the cookie). */
export async function currentAuth(): Promise<AuthContext | null> {
  const t = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!t) return null;
  const [row] = await db.select({
    s: schema.sessions, u: schema.users,
  }).from(schema.sessions).innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sessionHash(t)), gt(schema.sessions.expiresAt, new Date())));
  if (!row || row.u.deletedAt) return null;
  const orgId = row.s.activeOrganisationId;
  if (!orgId) return null;
  const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, row.u.id), eq(schema.memberships.organisationId, orgId)));
  if (!m && !row.u.isSuperAdmin) return null;
  return {
    sessionId: row.s.id, csrfToken: row.s.csrfToken,
    user: { id: row.u.id, email: row.u.email, username: row.u.username, name: row.u.name, locale: row.u.locale, isSuperAdmin: row.u.isSuperAdmin, hasTotp: hasActiveTotp(row.u.totpSecretEnc) },
    organisationId: orgId,
    membership: { roleKey: m?.roleKey ?? "SUPER_ADMIN", grants: m?.grants ?? [], denies: m?.denies ?? [], isSuperAdmin: row.u.isSuperAdmin },
    elevated: !!row.s.elevatedUntil && row.s.elevatedUntil > new Date(),
  };
}

export async function requireAuth(perm?: Permission): Promise<AuthContext> {
  const a = await currentAuth();
  if (!a) throw new AppError("unauthenticated", "Please sign in to continue.");
  if (perm && !can(a.membership, perm)) throw new AppError("forbidden", "You do not have permission to do that.");
  return a;
}

export function checkCsrf(auth: AuthContext, header: string | null, origin: string | null) {
  if (!header || !safeEqual(header, auth.csrfToken)) throw new AppError("forbidden", "Your session could not be verified. Refresh the page and try again.");
  if (origin && new URL(origin).origin !== new URL(env().APP_URL).origin) throw new AppError("forbidden", "Cross-site request blocked.");
}

export const hashForLog = (s: string) => sha256(s).slice(0, 12);
