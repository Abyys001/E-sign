import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { hasActiveTotp, verifyTotp } from "@/server/auth/totp";
import { sha256 } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { body, open } from "@/server/http";
import { listUserOrgs } from "@/server/orgs";
import { log } from "@/server/logger";
import { rateLimit } from "@/server/rate-limit";
import { getOrgSettings } from "@/server/settings";

// `login` is an email or a username; `email` is still accepted for older clients.
const Body = z.object({ login: z.string().trim().min(1).max(254).optional(), email: z.string().trim().min(1).max(254).optional(), password: z.string().min(1).max(200), totp: z.string().optional(), organisationId: z.string().uuid().optional() })
  .refine((b) => b.login || b.email, { message: "Enter your email or username.", path: ["login"] });
const GENERIC = "Email/username or password is incorrect.";

export const POST = open(async ({ req, ctx }) => {
  const b = await body(req, Body);
  const login = (b.login ?? b.email)!.toLowerCase();
  await rateLimit("login", ctx.ip ?? "unknown");
  await rateLimit("loginEmail", sha256(login));

  // Usernames can never contain "@", so the identifier is unambiguous.
  const match = login.includes("@") ? eq(schema.users.email, login) : sql`lower(${schema.users.username}) = ${login}`;
  const [u] = await db.select().from(schema.users).where(and(match, sql`${schema.users.deletedAt} is null`));
  if (u?.lockedUntil && u.lockedUntil > new Date()) throw new AppError("rate_limited", "This account is temporarily locked. Try again later.");
  const ok = await verifyPassword(u?.passwordHash, b.password);
  if (!u || !ok) {
    if (u) {
      const failed = u.failedLogins + 1;
      await db.update(schema.users).set({ failedLogins: failed, lockedUntil: failed >= 8 ? new Date(Date.now() + 15 * 60_000) : null }).where(eq(schema.users.id, u.id));
    }
    log.security("login_failed", { ip: ctx.ip, login: sha256(login).slice(0, 12) });
    throw new AppError("unauthenticated", GENERIC);
  }
  if (hasActiveTotp(u.totpSecretEnc)) {
    if (!b.totp) throw new AppError("unauthenticated", "Enter the 6-digit code from your authenticator app.", { totpRequired: true });
    if (!verifyTotp(u.totpSecretEnc, b.totp)) { log.security("totp_failed", { userId: u.id }); throw new AppError("unauthenticated", "That code is not valid.", { totpRequired: true }); }
  }

  const orgs = await listUserOrgs(u.id, u.isSuperAdmin);
  const chosen = orgs.find((o) => o.id === b.organisationId) ?? orgs[0] ?? null;
  const settings = chosen ? await getOrgSettings(chosen.id) : null;
  await db.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, u.id));
  const { csrf } = await createSession(u.id, chosen?.id ?? null, ctx, settings?.security.sessionHours ?? 24);
  if (chosen) await db.transaction((tx) => audit(tx, { organisationId: chosen.id, userId: u.id, eventType: "auth.login", ctx }));
  return { user: { id: u.id, name: u.name, email: u.email, username: u.username, locale: u.locale }, organisations: orgs, activeOrganisationId: chosen?.id ?? null, csrfToken: csrf };
});
