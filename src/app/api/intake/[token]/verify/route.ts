import { z } from "zod";
import { body, open } from "@/server/http";
import { requestIntakeOtp, verifyIntakeOtp, verifyIntakePasscode } from "@/server/intake/public";
import { cookieOf } from "../../cookie";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  const b = await body(req, z.discriminatedUnion("action", [z.object({ action: z.literal("request_code") }), z.object({ action: z.literal("verify_code"), code: z.string().max(10) }), z.object({ action: z.literal("verify_passcode"), passcode: z.string().max(200) })]));
  const c = cookieOf(req, params.token);
  return b.action === "request_code" ? requestIntakeOtp(params.token, c, ctx) : b.action === "verify_code" ? verifyIntakeOtp(params.token, c, b.code, ctx) : verifyIntakePasscode(params.token, c, b.passcode, ctx);
});
