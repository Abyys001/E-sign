import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { decrypt } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getOrgSettings } from "@/server/settings";
import { verifyTwilioSignature } from "@/server/messaging/sms";

/** Twilio status callback. The X-Twilio-Signature is verified with the auth token of the organisation that sent the message. */
export const POST = open(async ({ req, ctx }) => {
  await rateLimit("api", `inbound-sms:${ctx.ip}`);
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => { if (typeof v === "string") params[k] = v; });
  const sid = params.MessageSid, status = params.MessageStatus;
  const [m] = sid ? await db.select().from(schema.smsMessages).where(eq(schema.smsMessages.providerMessageId, sid)) : [];
  if (!m) return { ok: true };
  const s = await getOrgSettings(m.organisationId);
  const token = s.sms.authTokenEnc ? decrypt(s.sms.authTokenEnc) : env().SMS_AUTH_TOKEN;
  const url = `${env().APP_URL.replace(/\/$/, "")}${req.nextUrl.pathname}`;
  if (!token || !verifyTwilioSignature(token, url, params, req.headers.get("x-twilio-signature") ?? "")) throw new AppError("unauthenticated", "Invalid signature.");
  if (status === "delivered") await db.update(schema.smsMessages).set({ status: "DELIVERED", deliveredAt: new Date() }).where(eq(schema.smsMessages.id, m.id));
  else if (status === "failed" || status === "undelivered") await db.update(schema.smsMessages).set({ status: "FAILED", error: `provider:${params.ErrorCode ?? status}` }).where(eq(schema.smsMessages.id, m.id));
  return { ok: true };
});
