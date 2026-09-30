import { open } from "@/server/http";
import { loadByToken, requestOtp, signCookieName } from "@/server/signing/service";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  const l = await loadByToken(params.token, ctx);
  return requestOtp(l, req.cookies.get(signCookieName(l.request.id))?.value, ctx);
});
