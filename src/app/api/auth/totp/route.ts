import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { newTotpSecret, sealTotp, totpUri, verifyTotp } from "@/server/auth/totp";
import { AppError } from "@/server/errors";
import { authed, body } from "@/server/http";
import { verifyPassword } from "@/server/auth/password";

/** GET: begin enrolment (returns a pending secret + otpauth URI). POST: confirm with a code. DELETE: disable (needs password). */
export const GET = authed(null, async ({ auth }) => {
  // Re-enrolling would silently replace a live secret, i.e. disable 2FA without a password. Disabling requires DELETE + password.
  if (auth.user.hasTotp) throw new AppError("invalid_state", "Two-factor authentication is already on. Turn it off first to set it up again.");
  const secret = newTotpSecret();
  await db.update(schema.users).set({ totpSecretEnc: `pending:${sealTotp(secret)}` }).where(eq(schema.users.id, auth.user.id));
  return { secret, otpauthUri: totpUri(auth.user.email, secret) };
});

export const POST = authed(null, async ({ req, auth, ctx }) => {
  const { code } = await body(req, z.object({ code: z.string().regex(/^\d{6}$/) }));
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, auth.user.id));
  const pending = u!.totpSecretEnc?.startsWith("pending:") ? u!.totpSecretEnc.slice(8) : null;
  if (!pending) throw new AppError("invalid_state", "Start two-factor setup first.");
  if (!verifyTotp(pending, code)) throw new AppError("validation_failed", "That code is not valid.");
  await db.update(schema.users).set({ totpSecretEnc: pending }).where(eq(schema.users.id, auth.user.id));
  await db.transaction((tx) => audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "auth.totp_enabled", ctx }));
  return { enabled: true };
});

export const DELETE = authed(null, async ({ req, auth, ctx }) => {
  const { password } = await body(req, z.object({ password: z.string().max(200) }));
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, auth.user.id));
  if (!(await verifyPassword(u!.passwordHash, password))) throw new AppError("unauthenticated", "Password is incorrect.");
  await db.update(schema.users).set({ totpSecretEnc: null }).where(eq(schema.users.id, auth.user.id));
  await db.transaction((tx) => audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "auth.totp_disabled", ctx }));
  return { enabled: false };
});
