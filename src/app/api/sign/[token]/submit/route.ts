import { z } from "zod";
import { open, body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { signCookieName, submitSigning, loadByToken } from "@/server/signing/service";

const Field = z.object({
  value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string().max(5000) }),
    z.object({ kind: z.literal("bool"), checked: z.boolean() }),
    z.object({ kind: z.literal("attachment"), objectId: z.string().uuid(), bytes: z.number().int().nonnegative(), mime: z.string().max(100) }),
  ]).optional(),
  signature: z.object({ method: z.enum(["TYPED", "DRAWN", "UPLOADED"]), typedText: z.string().max(200).optional(), typedFont: z.string().max(60).optional(), imageDataUrl: z.string().max(2_500_000) }).optional(),
  renderedPng: z.string().max(2_500_000).optional(),
});
const B = z.object({ consent: z.boolean(), locale: z.enum(["en", "fa"]).default("en"), fields: z.record(z.string().max(80), Field) });

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  await rateLimit("signingSubmit", ctx.ip ?? "unknown");
  const input = await body(req, B);
  const l = await loadByToken(params.token, ctx);
  return submitSigning(params.token, req.cookies.get(signCookieName(l.request.id))?.value, input, ctx);
});
