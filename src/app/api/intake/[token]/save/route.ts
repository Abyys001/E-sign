import { z } from "zod";
import { body, open } from "@/server/http";
import { saveDraft } from "@/server/intake/public";
import { cookieOf } from "../../cookie";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  const b = await body(req, z.object({ patch: z.record(z.string(), z.unknown()), explicit: z.boolean().optional() }));
  return saveDraft(params.token, cookieOf(req, params.token), b, ctx);
});
