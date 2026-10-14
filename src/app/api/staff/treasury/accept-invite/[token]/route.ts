import { z } from "zod";
import { staffPublic } from "@/server/treasury/http";
import { setStaffPassword } from "@/server/treasury/auth";
import { body, requestContext } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const POST = staffPublic<{ token: string }>(async ({ req, ip, params, correlationId }) => {
  await rateLimit("treasuryLoginIp", ip);
  const b = await body(req, z.object({ password: z.string().min(1).max(400) }));
  return setStaffPassword(params.token, b.password, requestContext(req, correlationId));
});
