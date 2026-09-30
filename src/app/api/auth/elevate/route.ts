import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { verifyPassword } from "@/server/auth/password";
import { hasActiveTotp, verifyTotp } from "@/server/auth/totp";
import { AppError } from "@/server/errors";
import { authed, body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getOrgSettings } from "@/server/settings";

/** Re-authentication for sensitive admin actions (2FA when enrolled, otherwise password). */
export const POST = authed(null, async ({ req, auth, ctx }) => {
  const b = await body(req, z.object({ password: z.string().max(200).optional(), totp: z.string().optional() }));
  await rateLimit("loginEmail", `elevate:${auth.user.id}`);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, auth.user.id));
  const totpOn = hasActiveTotp(u!.totpSecretEnc);
  const okTotp = totpOn ? verifyTotp(u!.totpSecretEnc, b.totp ?? "") : false;
  const okPw = !totpOn && b.password ? await verifyPassword(u!.passwordHash, b.password) : false;
  if (!okTotp && !okPw) throw new AppError("unauthenticated", totpOn ? "That code is not valid." : "Password is incorrect.");
  const minutes = (await getOrgSettings(auth.organisationId)).security.elevationMinutes;
  const until = new Date(Date.now() + minutes * 60_000);
  await db.update(schema.sessions).set({ elevatedUntil: until }).where(eq(schema.sessions.id, auth.sessionId));
  await db.transaction((tx) => audit(tx, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "auth.elevated", ctx, metadata: { method: okTotp ? "totp" : "password" } }));
  return { elevatedUntil: until };
});
