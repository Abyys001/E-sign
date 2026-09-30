import { z } from "zod";
import { body, open } from "@/server/http";
import { acceptUserToken } from "@/server/orgs";
import { rateLimit } from "@/server/rate-limit";

export const POST = open(async ({ req, ctx }) => {
  await rateLimit("login", `invite:${ctx.ip}`);
  const b = await body(req, z.object({ token: z.string().min(20).max(80), password: z.string().min(1).max(200) }));
  await acceptUserToken(b.token, b.password, ctx);
  return { ok: true };
});
