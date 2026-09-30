import { z } from "zod";
import { open, body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { currentAuth } from "@/server/auth/session";
import { loadByToken, signCookieName, verifyAccount, verifyOtp, verifyPasscode } from "@/server/signing/service";

const B = z.object({ code: z.string().trim().min(1).max(64).optional() });

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  await rateLimit("otpVerifyIp", ctx.ip ?? "unknown");
  const { code } = await body(req, B);
  const l = await loadByToken(params.token, ctx);
  const cookie = req.cookies.get(signCookieName(l.request.id))?.value;
  const level = l.recipient.authLevel;
  if (level === "ACCOUNT") return verifyAccount(l, cookie, (await currentAuth())?.user.email ?? null, ctx).then(() => ({ verified: true }));
  if (!code) return { verified: false, message: "Enter the code." };
  if (level === "PASSCODE") return verifyPasscode(l, cookie, code, ctx);
  return verifyOtp(l, cookie, code, ctx);
});
