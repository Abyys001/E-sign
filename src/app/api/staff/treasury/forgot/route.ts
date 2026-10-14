import { z } from "zod";
import { staffPublic } from "@/server/treasury/http";
import { requestStaffReset } from "@/server/treasury/auth";
import { body, requestContext } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const POST = staffPublic(async ({ req, ip, correlationId }) => {
  const b = await body(req, z.object({ email: z.string().trim().email().max(200) }));
  await rateLimit("treasuryLoginIp", ip);
  await rateLimit("treasuryLoginEmail", b.email.toLowerCase());
  return requestStaffReset(b.email, requestContext(req, correlationId));
});
