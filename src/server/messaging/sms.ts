import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { audit } from "../audit";
import { decrypt, deriveSigningToken, safeEqual } from "../crypto";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { rateLimit } from "../rate-limit";
import { getOrgBranding, getOrgSettings } from "../settings";
import type { Locale } from "./templates";
import { appUrl } from "./render";

/** Provider port. Add a vendor by implementing this; nothing else in the app knows which vendor is used. */
export interface SmsProvider {
  readonly name: string;
  send(msg: { to: string; body: string; statusCallbackUrl?: string }): Promise<{ providerMessageId: string }>;
}

export class SmsNotConfiguredError extends Error {}

class TwilioProvider implements SmsProvider {
  readonly name = "twilio";
  constructor(private accountSid: string, private authToken: string, private from: string) {}
  async send(m: { to: string; body: string; statusCallbackUrl?: string }) {
    const form = new URLSearchParams({ To: m.to, From: this.from, Body: m.body });
    if (m.statusCallbackUrl) form.set("StatusCallback", m.statusCallbackUrl);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}` },
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !json.sid) throw new Error(`Twilio error ${res.status}: ${json.message ?? "unknown"}${json.code ? ` (code ${json.code})` : ""}`);
    return { providerMessageId: json.sid };
  }
}

export async function smsProviderFor(orgId: string): Promise<SmsProvider> {
  const s = await getOrgSettings(orgId);
  const e = env();
  const orgOn = s.sms.enabled && s.sms.provider === "twilio" && s.sms.accountId && s.sms.authTokenEnc && s.sms.fromNumber;
  if (orgOn) return new TwilioProvider(s.sms.accountId, decrypt(s.sms.authTokenEnc), s.sms.fromNumber);
  if (s.sms.enabled && e.SMS_PROVIDER === "twilio" && e.SMS_ACCOUNT_ID && e.SMS_AUTH_TOKEN && e.SMS_FROM_NUMBER) return new TwilioProvider(e.SMS_ACCOUNT_ID, e.SMS_AUTH_TOKEN, e.SMS_FROM_NUMBER);
  throw new SmsNotConfiguredError("SMS is not configured for this organisation.");
}

export async function smsAvailable(orgId: string): Promise<boolean> {
  try { await smsProviderFor(orgId); return true; } catch { return false; }
}

export const SMS_TEXT: Record<Locale, Record<string, string>> = {
  en: {
    invite: "{org}: {sender} asked you to sign “{contract}”. Open: {url}",
    otp: "Your Bilit.event E-Sign code is {code}. It expires in {minutes} minutes.",
    reminder: "Reminder from {org}: “{contract}” is waiting for your signature: {url}",
    expiry: "“{contract}” expires on {expiry}. Sign here: {url}",
    completed: "“{contract}” is fully signed. Your copy: {url}",
  },
  fa: {
    invite: "{org}: {sender} از شما خواسته «{contract}» را امضا کنید: {url}",
    otp: "کد Bilit.event E-Sign شما {code} است. تا {minutes} دقیقه معتبر است.",
    reminder: "یادآوری از {org}: «{contract}» منتظر امضای شماست: {url}",
    expiry: "«{contract}» در تاریخ {expiry} منقضی می‌شود: {url}",
    completed: "«{contract}» کامل امضا شد. نسخهٔ شما: {url}",
  },
};

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");

export type QueueSmsInput = { orgId: string; template: "invite" | "otp" | "reminder" | "expiry" | "completed"; toPhone: string; contractId?: string | null; recipientId?: string | null; vars: Record<string, string>; signatureRequestId?: string; locale?: Locale; dedupeKey: string; provider?: string };

/**
 * Queue an SMS. Recipients must have consented (checked by callers via recipients.sms_consent).
 * If no provider is configured the message is recorded as NOT_SENT: we never pretend it was delivered.
 */
export async function queueSms(tx: Tx, i: QueueSmsInput): Promise<string | null> {
  const s = await getOrgSettings(i.orgId, tx);
  await rateLimit("smsSend", i.orgId, s.rateLimits.smsPerHour ? { limit: s.rateLimits.smsPerHour } : undefined);
  const configured = await smsAvailable(i.orgId);
  const [row] = await tx.insert(schema.smsMessages).values({
    organisationId: i.orgId, contractId: i.contractId ?? null, recipientId: i.recipientId ?? null, template: i.template, toPhone: i.toPhone,
    provider: configured ? s.sms.provider === "twilio" ? "twilio" : env().SMS_PROVIDER : "none", status: configured ? "QUEUED" : "NOT_SENT",
    error: configured ? null : "SMS provider is not configured", dedupeKey: i.dedupeKey, locale: i.locale ?? s.general.locale,
    payload: { vars: i.vars, signatureRequestId: i.signatureRequestId ?? null },
  }).onConflictDoNothing().returning({ id: schema.smsMessages.id });
  if (!row) return null;
  if (configured) await enqueue(tx, QUEUES.sms, { messageId: row.id }, { singletonKey: row.id });
  return row.id;
}

export async function deliverSms(messageId: string, retryCount: number, retryLimit: number) {
  const [msg] = await db.select().from(schema.smsMessages).where(eq(schema.smsMessages.id, messageId));
  if (!msg || ["SENT", "DELIVERED", "NOT_SENT"].includes(msg.status)) return;
  const payload = msg.payload as { vars: Record<string, string>; signatureRequestId?: string | null };
  const vars = { ...payload.vars };
  if (vars.code_enc) { vars.code = decrypt(vars.code_enc); delete vars.code_enc; }
  if (payload.signatureRequestId) {
    const [r] = await db.select().from(schema.signatureRequests).where(eq(schema.signatureRequests.id, payload.signatureRequestId));
    if (!r || r.status !== "ACTIVE" || r.expiresAt < new Date()) { await db.update(schema.smsMessages).set({ status: "FAILED", error: "Skipped: the signing link is no longer active." }).where(eq(schema.smsMessages.id, msg.id)); return; }
    vars.url = appUrl(`/s/${deriveSigningToken(r.id, r.tokenNonce)}`);
  }
  try {
    const provider = await smsProviderFor(msg.organisationId);
    const brand = await getOrgBranding(msg.organisationId);
    const body = fill(SMS_TEXT[(msg.locale as Locale) ?? "en"][msg.template] ?? "", { org: brand.orgName, ...vars });
    const out = await provider.send({ to: msg.toPhone, body, statusCallbackUrl: appUrl("/api/webhooks/sms-status") });
    await db.transaction(async (tx) => {
      await tx.update(schema.smsMessages).set({ status: "SENT", providerMessageId: out.providerMessageId, sentAt: new Date(), attempts: sql`${schema.smsMessages.attempts} + 1`, error: null, ...(msg.template === "otp" ? { payload: {} } : {}) }).where(eq(schema.smsMessages.id, msg.id));
      if (msg.contractId) await audit(tx, { organisationId: msg.organisationId, contractId: msg.contractId, recipientId: msg.recipientId, eventType: "sms.sent", metadata: { template: msg.template, provider: provider.name } });
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("sms.send_failed", { messageId, err: message });
    const final = retryCount >= retryLimit || e instanceof SmsNotConfiguredError;
    await db.update(schema.smsMessages).set({ status: final ? "FAILED" : "QUEUED", error: message.slice(0, 400), attempts: sql`${schema.smsMessages.attempts} + 1` }).where(eq(schema.smsMessages.id, msg.id));
    if (!final) throw e;
  }
}

/** Verify Twilio's X-Twilio-Signature (HMAC-SHA1 over URL + sorted form params) using the auth token. */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return safeEqual(createHmac("sha1", authToken).update(data).digest("base64"), signature);
}
