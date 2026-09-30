import { z } from "zod";
import { body, open } from "@/server/http";
import { beat } from "@/server/intake/public";
import { cookieOf } from "../../cookie";

export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  const b = await body(req, z.object({ active: z.boolean().optional(), client: z.unknown().optional(), section: z.object({ key: z.string().max(64), state: z.enum(["entered", "completed"]) }).optional(), started: z.boolean().optional(), closing: z.boolean().optional() }));
  return beat(params.token, cookieOf(req, params.token), b, ctx);
});
