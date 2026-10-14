import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { encrypt, hashToken, hmac, newToken, randomId } from "../crypto";
import { queueEmail } from "../messaging/email";
import { appUrl } from "../messaging/render";
import { hashPassword, verifyPassword } from "../auth/password";
import { AppError } from "../errors";
import type { RequestContext } from "../audit";
import { logTreasury } from "./audit";

/**
 * Staff portal authentication — entirely separate from the organisation users' auth. Staff have their own password,
 * their own session cookie, and never hold a Stripe credential. Sessions are server-side rows; the cookie carries only
 * an opaque token whose HMAC is stored. Every lookup re-reads the staff row, so a suspension or revocation takes effect
 * on the next request.
 */
export const STAFF_COOKIE = "bes_tstaff";
export const STAFF_CSRF_COOKIE = "bes_tstaff_csrf";
const SESSION_HOURS = 12;
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
const secure = () => env().APP_URL.startsWith("https://");
const sessHash = (t: string) => hmac(env().SESSION_SECRET, `tstaff:${t}`);

export type StaffContext = {
  staff: typeof schema.treasuryStaff.$inferSelect;
  sessionId: string;
  csrf: string;
  ctx: RequestContext;
};

type Staff = typeof schema.treasuryStaff.$inferSelect;
const isUsable = (s: Staff) => s.status === "ACTIVE";

/** Resolve the current staff from the session cookie. Returns null for any invalid / expired / suspended case. */
export async function currentStaff(ctx: RequestContext): Promise<StaffContext | null> {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db.select({ s: schema.treasuryStaff, sessId: schema.treasuryStaffSessions.id, csrf: schema.treasuryStaffSessions.csrfToken })
    .from(schema.treasuryStaffSessions)
    .innerJoin(schema.treasuryStaff, eq(schema.treasuryStaff.id, schema.treasuryStaffSessions.staffId))
    .where(and(eq(schema.treasuryStaffSessions.tokenHash, sessHash(token)), gt(schema.treasuryStaffSessions.expiresAt, new Date())));
  if (!row || !isUsable(row.s)) return null;
  return { staff: row.s, sessionId: row.sessId, csrf: row.csrf, ctx };
}

export async function createStaffSession(staffId: string, ctx: RequestContext) {
  const token = randomId(32);
  const csrf = randomId(24);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db.insert(schema.treasuryStaffSessions).values({ staffId, tokenHash: sessHash(token), csrfToken: csrf, ip: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null, expiresAt });
  const jar = await cookies();
  jar.set(STAFF_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", expires: expiresAt });
  jar.set(STAFF_CSRF_COOKIE, csrf, { httpOnly: false, secure: secure(), sameSite: "lax", path: "/", expires: expiresAt });
  return { csrf };
}

export async function destroyStaffSession() {
  const jar = await cookies();
  const t = jar.get(STAFF_COOKIE)?.value;
  if (t) await db.delete(schema.treasuryStaffSessions).where(eq(schema.treasuryStaffSessions.tokenHash, sessHash(t)));
  jar.delete(STAFF_COOKIE); jar.delete(STAFF_CSRF_COOKIE);
}

/** Verify a staff email + password. Generic errors only (never reveal which part was wrong); lockout after repeated failures. */
export async function staffLogin(email: string, password: string, ctx: RequestContext): Promise<StaffContext> {
  // emails are unique across organisations (createStaff enforces it); an ambiguous match is refused rather than guessed
  const found = await db.select().from(schema.treasuryStaff).where(sql`lower(${schema.treasuryStaff.email}) = ${email.trim().toLowerCase()}`).limit(2);
  const s = found.length === 1 ? found[0] : undefined;
  const bad = new AppError("unauthenticated", "Incorrect email or password.");
  if (!s) { await verifyPassword(null, password); throw bad; } // equalise timing for unknown emails
  if (s.lockedUntil && s.lockedUntil > new Date()) throw new AppError("unauthenticated", "Too many attempts. Try again later.");
  if (s.status === "SUSPENDED" || s.status === "REVOKED") { await logTreasury(db, { orgId: s.organisationId, actorType: "STAFF", actorId: s.id, actorName: s.name, action: "staff.login", resource: "staff", resourceId: s.id, outcome: "DENY", ip: ctx.ip, metadata: { reason: s.status } }); throw new AppError("forbidden", "This account is not active. Contact your administrator."); }
  const ok = s.passwordHash ? await verifyPassword(s.passwordHash, password) : (await verifyPassword(null, password), false);
  if (!ok) {
    const failed = s.failedLogins + 1;
    await db.update(schema.treasuryStaff).set({ failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null, updatedAt: new Date() }).where(eq(schema.treasuryStaff.id, s.id));
    await logTreasury(db, { orgId: s.organisationId, actorType: "STAFF", actorId: s.id, actorName: s.name, action: "staff.login", resource: "staff", resourceId: s.id, outcome: "DENY", ip: ctx.ip, metadata: { failed } });
    throw bad;
  }
  await db.update(schema.treasuryStaff).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(schema.treasuryStaff.id, s.id));
  const { csrf } = await createStaffSession(s.id, ctx);
  await logTreasury(db, { orgId: s.organisationId, actorType: "STAFF", actorId: s.id, actorName: s.name, action: "staff.login", resource: "staff", resourceId: s.id, outcome: "OK", ip: ctx.ip });
  return { staff: { ...s, failedLogins: 0, lastLoginAt: new Date() }, sessionId: "", csrf, ctx };
}

/** Mint a single-use invite (or reset) link token for a staff member. Returns the raw token for the email; only its hash is stored. */
export async function issueStaffToken(tx: Tx, staffId: string, purpose: "INVITE" | "RESET") {
  const { token } = newToken();
  await tx.delete(schema.treasuryStaffTokens).where(and(eq(schema.treasuryStaffTokens.staffId, staffId), eq(schema.treasuryStaffTokens.purpose, purpose), isNull(schema.treasuryStaffTokens.usedAt)));
  await tx.insert(schema.treasuryStaffTokens).values({ staffId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + (purpose === "INVITE" ? 7 * 86400_000 : 3600_000)) });
  return token;
}

/** Consume an invite/reset token and set the password. Activates an invited account. */
export async function setStaffPassword(token: string, password: string, ctx: RequestContext) {
  if (password.length < 10) throw new AppError("validation_failed", "Use at least 10 characters.", [{ path: "password", message: "At least 10 characters" }]);
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(schema.treasuryStaffTokens).where(and(eq(schema.treasuryStaffTokens.tokenHash, hashToken(token)), isNull(schema.treasuryStaffTokens.usedAt), gt(schema.treasuryStaffTokens.expiresAt, new Date()))).for("update");
    if (!t) throw new AppError("gone", "This link is invalid or has expired. Ask your administrator for a new one.");
    const [s] = await tx.select().from(schema.treasuryStaff).where(eq(schema.treasuryStaff.id, t.staffId)).for("update");
    if (!s || s.status === "REVOKED") throw new AppError("gone", "This account is no longer available.");
    await tx.update(schema.treasuryStaffTokens).set({ usedAt: new Date() }).where(eq(schema.treasuryStaffTokens.id, t.id));
    await tx.update(schema.treasuryStaff).set({ passwordHash: await hashPassword(password), status: s.status === "INVITED" ? "ACTIVE" : s.status, failedLogins: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(schema.treasuryStaff.id, s.id));
    // any existing sessions are invalidated when a password is (re)set
    await tx.delete(schema.treasuryStaffSessions).where(eq(schema.treasuryStaffSessions.staffId, s.id));
    await logTreasury(tx, { orgId: s.organisationId, actorType: "STAFF", actorId: s.id, actorName: s.name, action: "staff.password_set", resource: "staff", resourceId: s.id, outcome: "OK", ip: ctx.ip });
    return { email: s.email };
  });
}

/**
 * Self-service "forgot password": always answers the same way whether or not the email exists, so it cannot be used to
 * discover accounts. Only an ACTIVE staff member with a password gets a (one-hour, single-use) reset link by email.
 */
export async function requestStaffReset(email: string, ctx: RequestContext) {
  const found = await db.select().from(schema.treasuryStaff).where(sql`lower(${schema.treasuryStaff.email}) = ${email.trim().toLowerCase()}`).limit(2);
  const s = found.length === 1 ? found[0]! : null;
  if (!s || s.status !== "ACTIVE" || !s.passwordHash) return { ok: true };
  await db.transaction(async (tx) => {
    const token = await issueStaffToken(tx, s.id, "RESET");
    const url = appUrl(`/staff/treasury/accept-invite/${token}`);
    await queueEmail(tx, { orgId: s.organisationId, template: "password_reset", toEmail: s.email, vars: { recipient_name: s.name, invite_url_enc: encrypt(url) }, dedupeKey: `tstaff:RESET:${s.id}:${token.slice(0, 10)}` });
    await logTreasury(tx, { orgId: s.organisationId, actorType: "STAFF", actorId: s.id, actorName: s.name, action: "staff.reset_requested", resource: "staff", resourceId: s.id, outcome: "OK", ip: ctx.ip });
  });
  return { ok: true };
}

/** Drop every session for a staff member — used by the admin on suspend / revoke, taking effect immediately. */
export async function revokeStaffSessions(tx: Tx, staffId: string) {
  await tx.delete(schema.treasuryStaffSessions).where(eq(schema.treasuryStaffSessions.staffId, staffId));
}

/** CSRF for mutating staff requests: the cookie value must equal the submitted header. */
export function assertStaffCsrf(sentHeader: string | null, csrf: string) {
  if (!sentHeader || sentHeader.length !== csrf.length || !timingSafeEqual(Buffer.from(sentHeader), Buffer.from(csrf))) throw new AppError("forbidden", "Invalid or missing CSRF token.");
}

export const _internal = { sessHash, sql };
