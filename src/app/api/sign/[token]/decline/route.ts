import { z } from "zod";
import { open, body } from "@/server/http";
import { declineSigning, loadByToken, signCookieName } from "@/server/signing/service";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  const { reason } = await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }));
  const l = await loadByToken(params.token, ctx);
  return declineSigning(params.token, req.cookies.get(signCookieName(l.request.id))?.value, reason, ctx);
});
