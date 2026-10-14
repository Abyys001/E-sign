import { z } from "zod";
import { staffPublic } from "@/server/treasury/http";
import { staffLogin } from "@/server/treasury/auth";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { requestContext } from "@/server/http";

export const POST = staffPublic(async ({ req, ip, correlationId }) => {
  const b = await body(req, z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(400) }));
  await rateLimit("treasuryLoginIp", ip);
  await rateLimit("treasuryLoginEmail", b.email.trim().toLowerCase());
  const sc = await staffLogin(b.email, b.password, requestContext(req, correlationId));
  return { ok: true, csrf: sc.csrf, name: sc.staff.name };
});
