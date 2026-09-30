import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { audit } from "../audit";
import { decrypt, deriveIntakeToken, deriveSigningToken } from "../crypto";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { contractStakeholders, notifyUsers } from "../notifications";
import { rateLimit } from "../rate-limit";
import { getOrgBranding, getOrgSettings } from "../settings";
import { DEFAULT_TEMPLATES, type EmailTemplateKey, type Locale } from "./templates";
import { appUrl, buttonHtml, esc, layout, onColor, renderVars, sanitizeBody, stripHtml, type Brand } from "./render";

const PLATFORM_PRIMARY = "#20ac6a"; // --color-5, the product primary

export type QueueEmailInput = {
  orgId: string;
  template: EmailTemplateKey;
  toEmail: string;
  contractId?: string | null;
  recipientId?: string | null;
  /** Non-secret template variables. The signing URL is derived at send time from `signatureRequestId`. */
  vars?: Record<string, string>;
  signatureRequestId?: string;
  downloadForRequestId?: string;
  /** Intake link; the URL is derived at send time and skipped if the invitation was revoked or expired. */
  intakeInvitationId?: string;
  locale?: Locale;
  /** Idempotency: the same key never produces a second message. */
  dedupeKey: string;
};

/** Insert the message row and enqueue delivery in the caller's transaction. Returns null when this dedupe key already exists. */
export async function queueEmail(tx: Tx, i: QueueEmailInput): Promise<string | null> {
  const settings = await getOrgSettings(i.orgId, tx);
  await rateLimit("emailSend", i.orgId, settings.rateLimits.emailPerHour ? { limit: settings.rateLimits.emailPerHour } : undefined);
  const locale = i.locale ?? settings.general.locale;
  const tpl = await loadTemplate(tx, i.orgId, i.template, locale);
  const [row] = await tx.insert(schema.emailMessages).values({
    organisationId: i.orgId, contractId: i.contractId ?? null, recipientId: i.recipientId ?? null, template: i.template, toEmail: i.toEmail.toLowerCase(),
    subject: tpl.subject, status: "QUEUED", dedupeKey: i.dedupeKey, locale,
    payload: { vars: i.vars ?? {}, signatureRequestId: i.signatureRequestId ?? null, downloadForRequestId: i.downloadForRequestId ?? null, intakeInvitationId: i.intakeInvitationId ?? null },
  }).onConflictDoNothing().returning({ id: schema.emailMessages.id });
  if (!row) return null;
  await enqueue(tx, QUEUES.email, { messageId: row.id }, { singletonKey: row.id });
  return row.id;
}

export async function loadTemplate(tx: Pick<typeof db, "select">, orgId: string, key: EmailTemplateKey, locale: Locale) {
  const [custom] = await tx.select().from(schema.emailTemplates).where(and(eq(schema.emailTemplates.organisationId, orgId), eq(schema.emailTemplates.key, key), eq(schema.emailTemplates.locale, locale)));
  if (custom?.enabled) return { subject: custom.subject, body: sanitizeBody(custom.bodyHtml), custom: true, version: custom.version };
  return { ...DEFAULT_TEMPLATES[locale][key], custom: false, version: 0 };
}

export async function brandFor(orgId: string): Promise<Brand> {
  const b = await getOrgBranding(orgId);
  const primary = b.primaryColor ?? PLATFORM_PRIMARY;
  return { orgName: b.orgName, primary, onPrimary: onColor(primary), footer: b.emailFooter, supportEmail: b.supportEmail, supportPhone: b.supportPhone };
}

const BUTTON_LABEL: Record<Locale, { sign: string; download: string; invite: string; form: string; review: string }> = {
  en: { sign: "Review and sign", download: "View completed document", invite: "Accept invitation", form: "Open secure form", review: "Open in Bilit.event E-Sign" },
  fa: { sign: "مشاهده و امضا", download: "مشاهدهٔ سند تکمیل‌شده", invite: "پذیرش دعوت", form: "باز کردن فرم امن", review: "باز کردن در Bilit.event E-Sign" },
};

export type RenderedEmail = { subject: string; html: string; text: string; brand: Brand };

/** Pure render used by both delivery and the template-editor preview. */
export function renderEmail(tpl: { subject: string; body: string }, vars: Record<string, string>, brand: Brand, locale: Locale): RenderedEmail {
  const l = BUTTON_LABEL[locale];
  const allVars: Record<string, string> = {
    ...vars,
    organisation_name: vars.organisation_name ?? brand.orgName,
    support_email: vars.support_email ?? brand.supportEmail,
    support_phone: vars.support_phone ?? brand.supportPhone,
    signing_button: vars.signing_url ? buttonHtml(vars.signing_url, l.sign, brand) : "",
    download_button: vars.download_url ? buttonHtml(vars.download_url, l.download, brand) : "",
    invite_button: vars.invite_url ? buttonHtml(vars.invite_url, l.invite, brand) : "",
    form_button: vars.form_url ? buttonHtml(vars.form_url, l.form, brand) : "",
    review_button: vars.review_url ? buttonHtml(vars.review_url, l.review, brand) : "",
  };
  const subject = renderVars(tpl.subject, allVars, { html: false }).replace(/[\r\n]+/g, " ").slice(0, 200);
  const inner = renderVars(tpl.body, allVars, { html: true });
  const html = layout(message(inner, vars.message), brand, locale, subject);
  return { subject, html, text: stripHtml(inner), brand };
}
/** `{{message}}` renders as an empty paragraph when the sender wrote none; drop it. */
const message = (inner: string, msg?: string) => (msg ? inner : inner.replace(/<p>\s*<\/p>/g, ""));

let logoBuf: Buffer | undefined;
async function logo() { return (logoBuf ??= await readFile(path.join(process.cwd(), "public/brand/bilit-esign-logo-email.png"))); }

type SmtpCfg = { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string; replyTo?: string; headers?: Record<string, string> };
const transports = new Map<string, Transporter>();

export async function smtpConfigFor(orgId: string): Promise<SmtpCfg | null> {
  const s = await getOrgSettings(orgId);
  const b = await getOrgBranding(orgId);
  if (s.email.useOrgSmtp && s.email.host) {
    const fromAddr = s.email.fromAddress || env().SMTP_FROM;
    return {
      host: s.email.host, port: s.email.port, secure: s.email.secure, user: s.email.user || undefined, pass: s.email.passwordEnc ? decrypt(s.email.passwordEnc) : undefined,
      from: s.email.fromName && s.email.fromAddress ? `"${s.email.fromName.replace(/"/g, "")}" <${s.email.fromAddress}>` : fromAddr,
      replyTo: s.email.replyTo || b.supportEmail || undefined, headers: s.email.headers,
    };
  }
  const e = env();
  if (!e.SMTP_HOST) return null;
  const addr = /<([^>]+)>/.exec(e.SMTP_FROM)?.[1] ?? e.SMTP_FROM;
  return {
    host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE === "true", user: e.SMTP_USER || undefined, pass: e.SMTP_PASSWORD || undefined,
    from: `"${(b.orgName || "Bilit.event E-Sign").replace(/"/g, "")} via Bilit.event E-Sign" <${addr}>`, replyTo: s.email.replyTo || b.supportEmail || e.SMTP_REPLY_TO || undefined,
  };
}

function transportFor(c: SmtpCfg): Transporter {
  const k = `${c.host}:${c.port}:${c.secure}:${c.user ?? ""}`;
  let t = transports.get(k);
  if (!t) {
    t = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass ?? "" } : undefined, connectionTimeout: 15_000, socketTimeout: 30_000, tls: { minVersion: "TLSv1.2" } });
    transports.set(k, t);
  }
  return t;
}

export async function buildMessageVars(msg: typeof schema.emailMessages.$inferSelect): Promise<Record<string, string>> {
  const payload = msg.payload as { vars?: Record<string, string>; signatureRequestId?: string | null; downloadForRequestId?: string | null; intakeInvitationId?: string | null };
  const vars: Record<string, string> = { ...(payload.vars ?? {}) };
  if (vars.invite_url_enc) { vars.invite_url = decrypt(vars.invite_url_enc); delete vars.invite_url_enc; }
  if (vars.otp_code_enc) { vars.otp_code = decrypt(vars.otp_code_enc); delete vars.otp_code_enc; } // OTPs are never stored in clear
  if (payload.intakeInvitationId) {
    const [inv] = await db.select().from(schema.intakeInvitations).where(and(eq(schema.intakeInvitations.id, payload.intakeInvitationId), eq(schema.intakeInvitations.organisationId, msg.organisationId)));
    if (inv) vars.form_url = appUrl(`/intake/${deriveIntakeToken(inv.id, inv.tokenNonce)}`);
  }
  const reqId = payload.signatureRequestId ?? payload.downloadForRequestId;
  if (reqId) {
    const [r] = await db.select().from(schema.signatureRequests).where(and(eq(schema.signatureRequests.id, reqId), eq(schema.signatureRequests.organisationId, msg.organisationId)));
    if (r) {
      const url = appUrl(`/s/${deriveSigningToken(r.id, r.tokenNonce)}`);
      if (payload.signatureRequestId) vars.signing_url = url;
      if (payload.downloadForRequestId) vars.download_url = url;
    }
  }
  return vars;
}

/** Job handler. Idempotent: an already-sent message is never sent twice. Failures retry with backoff; only the last failure is final. */
export async function deliverEmail(messageId: string, retryCount: number, retryLimit: number) {
  // Atomic claim: only one worker can move QUEUED -> SENDING, so a duplicate job or a sweep can never send the same message twice.
  const [msg] = await db.update(schema.emailMessages).set({ status: "SENDING", sendingAt: new Date() }).where(and(eq(schema.emailMessages.id, messageId), eq(schema.emailMessages.status, "QUEUED"))).returning();
  if (!msg) return;
  const orgId = msg.organisationId;
  const payload = msg.payload as { signatureRequestId?: string | null; intakeInvitationId?: string | null };
  const failFinal = async (error: string) => {
    await db.transaction(async (tx) => {
      await tx.update(schema.emailMessages).set({ status: "FAILED", error: error.slice(0, 500), attempts: sql`${schema.emailMessages.attempts} + 1` }).where(eq(schema.emailMessages.id, msg.id));
      if (msg.contractId) {
        const [c] = await tx.select({ createdBy: schema.contracts.createdBy, name: schema.contracts.name }).from(schema.contracts).where(eq(schema.contracts.id, msg.contractId));
        if (c) await notifyUsers(tx, orgId, await contractStakeholders(tx, orgId, c.createdBy), "delivery.failed", msg.contractId, { to: msg.toEmail, template: msg.template, error: error.slice(0, 200), contractName: c.name });
        await audit(tx, { organisationId: orgId, contractId: msg.contractId, recipientId: msg.recipientId, eventType: "email.failed", metadata: { template: msg.template, to: msg.toEmail, error: error.slice(0, 200) } });
      }
    });
  };

  const [suppressed] = await db.select({ reason: schema.emailSuppressions.reason }).from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.organisationId, orgId), eq(schema.emailSuppressions.email, msg.toEmail.toLowerCase())));
  if (suppressed) {
    await db.update(schema.emailMessages).set({ status: "SUPPRESSED", error: `Not sent: this address previously ${suppressed.reason === "COMPLAINT" ? "reported a complaint" : "bounced"}.` }).where(eq(schema.emailMessages.id, msg.id));
    if (msg.contractId) await db.transaction((tx) => audit(tx, { organisationId: orgId, contractId: msg.contractId!, recipientId: msg.recipientId, eventType: "email.suppressed", metadata: { template: msg.template, to: msg.toEmail, reason: suppressed.reason } }));
    return;
  }

  if (payload.signatureRequestId) {
    const [r] = await db.select({ status: schema.signatureRequests.status, exp: schema.signatureRequests.expiresAt }).from(schema.signatureRequests).where(eq(schema.signatureRequests.id, payload.signatureRequestId));
    if (!r || r.status !== "ACTIVE" || r.exp < new Date()) {
      await db.update(schema.emailMessages).set({ status: "FAILED", error: "Skipped: the signing link is no longer active." }).where(eq(schema.emailMessages.id, msg.id));
      return;
    }
  }

  if (payload.intakeInvitationId) {
    const [inv] = await db.select({ status: schema.intakeInvitations.status, exp: schema.intakeInvitations.expiresAt }).from(schema.intakeInvitations).where(eq(schema.intakeInvitations.id, payload.intakeInvitationId));
    if (!inv || inv.status !== "SENT" || inv.exp < new Date()) {
      await db.update(schema.emailMessages).set({ status: "FAILED", error: "Skipped: the intake link is no longer active." }).where(eq(schema.emailMessages.id, msg.id));
      return;
    }
  }

  const cfg = await smtpConfigFor(orgId);
  if (!cfg) { await failFinal("Email is not configured: set SMTP_HOST or an organisation SMTP server."); return; }

  try {
    const brand = await brandFor(orgId);
    const locale = (msg.locale as Locale) ?? "en";
    const tpl = await loadTemplate(db, orgId, msg.template as EmailTemplateKey, locale);
    const vars = await buildMessageVars(msg);
    const out = renderEmail(tpl, vars, brand, locale);
    const info = await transportFor(cfg).sendMail({
      from: cfg.from, to: msg.toEmail, subject: out.subject, html: out.html, text: out.text, replyTo: cfg.replyTo,
      headers: { ...(cfg.headers ?? {}), "X-Bilit-Message": msg.id, "Auto-Submitted": "auto-generated" },
      attachments: [{ filename: "logo.png", content: await logo(), cid: "bilit-logo" }],
    });
    const rejected = (info.rejected ?? []).length > 0;
    await db.transaction(async (tx) => {
      await tx.update(schema.emailMessages).set({
        status: rejected ? "FAILED" : "SENT", messageId: info.messageId, providerResponse: String(info.response ?? "").slice(0, 300), sentAt: new Date(), subject: out.subject,
        error: rejected ? "Recipient rejected by the mail server" : null, attempts: sql`${schema.emailMessages.attempts} + 1`,
        ...(["otp_code", "invite", "password_reset"].includes(msg.template) ? { payload: {} } : {}), // scrub the sealed code once delivered
      }).where(eq(schema.emailMessages.id, msg.id));
      if (msg.contractId) await audit(tx, { organisationId: orgId, contractId: msg.contractId, recipientId: msg.recipientId, eventType: rejected ? "email.failed" : "email.sent", metadata: { template: msg.template, to: msg.toEmail, messageId: info.messageId } });
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("email.send_failed", { messageId, retryCount, err: message });
    if (retryCount >= retryLimit) { await failFinal(message); return; }
    await db.update(schema.emailMessages).set({ status: "QUEUED", sendingAt: null, error: message.slice(0, 500), attempts: sql`${schema.emailMessages.attempts} + 1` }).where(eq(schema.emailMessages.id, msg.id));
    throw e;
  }
}

export const previewVars = (brand: Brand): Record<string, string> => ({
  recipient_name: "Sam Rivera", sender_name: "Alex Morgan", contract_name: "Venue hire agreement", contract_reference: "CTR-2026-000123",
  signing_url: "https://example.invalid/s/preview", download_url: "https://example.invalid/s/preview", expiry_date: "30 Nov 2026", organisation_name: brand.orgName,
  support_email: brand.supportEmail, support_phone: brand.supportPhone, message: "Please sign by Friday.", decline_reason: "Terms not agreed", otp_code: "123456",
  signer_name: "Sam Rivera", invite_url: "https://example.invalid/invite/preview", days_left: "3", reason: "Superseded by a new version",
  form_title: "Organizer – Bilit Event Ticketing & Distribution Agreement", form_url: "https://example.invalid/intake/preview", event_name: "Spring Gala", review_url: "https://example.invalid/contracts/preview",
  new_event_date: "12 December 2026", refund_details: "Your tickets remain valid for the new date. You may request a refund of the ticket amount until 15 December 2026.", submitted_by: "Example Events Ltd",
});
export { esc };
