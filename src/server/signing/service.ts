import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { PDFDocument } from "@cantoo/pdf-lib";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { encrypt, hashOtp, hashToken, hmac, newOtp, randomId, safeEqual, sha256 } from "../crypto";
import { env } from "@/lib/env";
import { AppError } from "../errors";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { rateLimit } from "../rate-limit";
import { getOrgBranding, getOrgSettings } from "../settings";
import { verifyPassword } from "../auth/password";
import { emitWebhook } from "../webhooks/events";
import { contractStakeholders, notifyUsers } from "../notifications";
import { queueEmail } from "../messaging/email";
import { queueSms, smsAvailable } from "../messaging/sms";
import { actionableNow, everyoneRequiredSigned, blockedBy, isActingRow, liveRecipients } from "../contracts/routing";
import { lockContract, transition, inviteRecipients } from "../contracts/service";
import { SIGNATURE_TYPES, TEXTUAL_TYPES, isWinAnsi, toKitField } from "../contracts/fields";
import { isInFlight } from "../contracts/state-machine";
import { missingRequiredFields, validateFieldValue, type Field, type FieldValue } from "../kit/fields/fields";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import type { Locale } from "../messaging/templates";

export const signCookieName = (requestId: string) => `sg_${requestId.replace(/-/g, "").slice(0, 12)}`;
const sessionHash = (v: string) => hmac(env().SESSION_SECRET, `sign:${v}`);

const GENERIC_INVALID = "This signing link is not valid. Check that you copied the whole link from your email.";

type Request = typeof schema.signatureRequests.$inferSelect;
type Recipient = typeof schema.recipients.$inferSelect;
type Contract = typeof schema.contracts.$inferSelect;

export type Loaded = { request: Request; recipient: Recipient; contract: Contract };

/** Resolve a signing token. Unknown tokens are rate limited per IP (token-guessing defence) and never explain why they failed. */
export async function loadByToken(token: string, ctx: RequestContext): Promise<Loaded> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    await rateLimit("signingTokenGuess", ctx.ip ?? "unknown");
    throw new AppError("not_found", GENERIC_INVALID);
  }
  const [req] = await db.select().from(schema.signatureRequests).where(eq(schema.signatureRequests.tokenHash, hashToken(token)));
  if (!req) {
    await rateLimit("signingTokenGuess", ctx.ip ?? "unknown");
    throw new AppError("not_found", GENERIC_INVALID);
  }
  const [recipient] = await db.select().from(schema.recipients).where(eq(schema.recipients.id, req.recipientId));
  const [contract] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, req.contractId));
  if (!recipient || !contract || contract.organisationId !== req.organisationId || recipient.organisationId !== req.organisationId) throw new AppError("not_found", GENERIC_INVALID);
  return { request: req, recipient, contract };
}

/** Whether this link may still be used to SIGN. Read-only completion access is decided separately. */
export function assertActive({ request, recipient, contract }: Loaded) {
  if (request.status === "REVOKED") throw new AppError("gone", "This link is no longer active. It may have been replaced by a newer email or the request was cancelled.");
  if (request.status === "EXPIRED" || request.expiresAt < new Date()) throw new AppError("gone", "This signing link has expired. Please ask the sender to send a new one.");
  if (request.status === "USED" || recipient.status === "COMPLETED") throw new AppError("conflict", "You have already signed this document.", { code: "already_signed" });
  if (recipient.status === "DECLINED" || recipient.status === "REMOVED") throw new AppError("gone", "This request is no longer active.");
  if (!isInFlight(contract.status)) throw new AppError("gone", `This document is no longer open for signing (${contract.status.toLowerCase().replace(/_/g, " ")}).`);
}

/** Browser-session binding: the token opens the door, the cookie proves it is the same browser that opened it. */
export async function bindSession(loaded: Loaded, cookieValue: string | undefined, ctx: RequestContext): Promise<{ sessionValue: string; sessionId: string; replaced: boolean }> {
  const { request } = loaded;
  if (cookieValue && request.sessionHash && safeEqual(sessionHash(cookieValue), request.sessionHash)) return { sessionValue: cookieValue, sessionId: request.id, replaced: false };
  const value = randomId(24);
  const replaced = !!request.sessionHash;
  await db.transaction(async (tx) => {
    await tx.update(schema.signatureRequests).set({ sessionHash: sessionHash(value), verifiedAt: null }).where(eq(schema.signatureRequests.id, request.id));
    if (replaced) await audit(tx, { organisationId: request.organisationId, contractId: request.contractId, recipientId: request.recipientId, eventType: "signing.session_replaced", ctx, metadata: { note: "Link opened from a different browser; earlier session and verification were invalidated." } });
  });
  return { sessionValue: value, sessionId: request.id, replaced };
}

export function assertSession(loaded: Loaded, cookieValue: string | undefined) {
  const { request } = loaded;
  if (!cookieValue || !request.sessionHash || !safeEqual(sessionHash(cookieValue), request.sessionHash)) throw new AppError("forbidden", "Your signing session has expired. Reopen the link from your email.", { code: "session_required" });
}

export function needsVerification(l: Loaded): "NONE" | "EMAIL_OTP" | "SMS_OTP" | "PASSCODE" | "ACCOUNT" {
  if (l.recipient.authLevel === "LINK" || l.request.verifiedAt) return "NONE";
  return l.recipient.authLevel as "EMAIL_OTP" | "SMS_OTP" | "PASSCODE" | "ACCOUNT";
}

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1•••$2");
const maskPhone = (p: string) => p.replace(/.(?=.{2})/g, "•");

// ------------------------------------------------------------------ open / view

export async function recordLinkAccess(l: Loaded, ctx: RequestContext) {
  await db.transaction((tx) => audit(tx, { organisationId: l.request.organisationId, contractId: l.contract.id, recipientId: l.recipient.id, eventType: "signing.link_accessed", ctx }));
}

/** First time the signer actually sees the document (after any verification): status changes, notifications, audit. */
export async function markViewed(l: Loaded, ctx: RequestContext) {
  if (l.recipient.viewedAt) return;
  await db.transaction(async (tx) => {
    const c = await lockContract(tx, l.request.organisationId, l.contract.id);
    const [r] = await tx.select().from(schema.recipients).where(eq(schema.recipients.id, l.recipient.id));
    if (!r || r.viewedAt) return;
    await tx.update(schema.recipients).set({ status: "VIEWED", viewedAt: new Date() }).where(eq(schema.recipients.id, r.id));
    if (c.status === "SENT" || c.status === "DELIVERED") await transition(tx, { orgId: c.organisationId, ctx }, c, "VIEWED", {});
    else if (c.status === "AWAITING_SIGNATURE") await transition(tx, { orgId: c.organisationId, ctx }, c, "PARTIALLY_SIGNED", {});
    await audit(tx, { organisationId: c.organisationId, contractId: c.id, recipientId: r.id, eventType: "document.viewed", ctx, documentHash: await signingHash(tx, c) });
    const s = await getOrgSettings(c.organisationId, tx);
    const stake = await contractStakeholders(tx, c.organisationId, c.createdBy);
    await notifyUsers(tx, c.organisationId, stake, "contract.viewed", c.id, { contractName: c.name, reference: c.reference, by: r.name });
    if (s.notifications.notifySenderOnView) await mailSender(tx, c, "contract_viewed", { signer_name: r.name }, `viewed:${r.id}`);
    await emitWebhook(tx, c.organisationId, "contract.viewed", { contractId: c.id, reference: c.reference, recipientId: r.id }, `contract.viewed:${r.id}`);
  });
}

async function signingHash(tx: Pick<typeof db, "select">, c: Contract): Promise<string | null> {
  if (!c.signingVersionId) return null;
  const [v] = await tx.select({ h: schema.contractVersions.sha256 }).from(schema.contractVersions).where(eq(schema.contractVersions.id, c.signingVersionId));
  return v?.h ?? null;
}

async function mailSender(tx: Tx, c: Contract, template: "contract_viewed" | "signer_completed" | "declined" | "all_signatures_completed", extra: Record<string, string>, key: string) {
  const [u] = await tx.select({ name: schema.users.name, email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, c.createdBy));
  if (!u) return;
  const brand = await getOrgBranding(c.organisationId);
  await queueEmail(tx, { orgId: c.organisationId, template, toEmail: u.email, contractId: c.id, locale: u.locale as Locale, vars: { recipient_name: u.name, sender_name: u.name, contract_name: c.name, contract_reference: c.reference, organisation_name: brand.orgName, ...extra }, dedupeKey: `${template}:${c.id}:${key}` });
}

// ------------------------------------------------------------------ verification (OTP / passcode)

const OTP_COOLDOWN_SECONDS = 45;

export async function requestOtp(l: Loaded, cookie: string | undefined, ctx: RequestContext) {
  assertActive(l); assertSession(l, cookie);
  const level = l.recipient.authLevel;
  if (level !== "EMAIL_OTP" && level !== "SMS_OTP") throw new AppError("bad_request", "This request does not use a verification code.");
  await rateLimit("otpRequest", l.request.id);
  await rateLimit("otpRequest", `ip:${ctx.ip}`);
  const s = await getOrgSettings(l.request.organisationId);
  const channel = level === "EMAIL_OTP" ? "EMAIL" : "SMS";
  if (channel === "SMS" && (!l.recipient.phone || !(await smsAvailable(l.request.organisationId)))) throw new AppError("config_missing", "Text-message verification is not available right now. Please contact the sender.");

  await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from signature_requests where id = ${l.request.id} for update`);
    const [last] = await tx.select().from(schema.otpSessions).where(eq(schema.otpSessions.signatureRequestId, l.request.id)).orderBy(desc(schema.otpSessions.createdAt)).limit(1);
    if (last && Date.now() - last.createdAt.getTime() < OTP_COOLDOWN_SECONDS * 1000) throw new AppError("rate_limited", "A code was just sent. Please wait a moment before requesting another.", { retryAfterSeconds: OTP_COOLDOWN_SECONDS }, { "Retry-After": String(OTP_COOLDOWN_SECONDS) });
    const sessionId = crypto.randomUUID();
    const otp = newOtp();
    await tx.insert(schema.otpSessions).values({ id: sessionId, organisationId: l.request.organisationId, recipientId: l.recipient.id, signatureRequestId: l.request.id, channel, codeHash: otp.hash(sessionId), maxAttempts: s.signing.otpMaxAttempts, expiresAt: new Date(Date.now() + s.signing.otpTtlMinutes * 60_000), ip: ctx.ip ?? null });
    const brand = await getOrgBranding(l.request.organisationId);
    if (channel === "EMAIL") {
      await queueEmail(tx, { orgId: l.request.organisationId, template: "otp_code", toEmail: l.recipient.email, contractId: l.contract.id, recipientId: l.recipient.id, vars: { recipient_name: l.recipient.name, contract_name: l.contract.name, organisation_name: brand.orgName, otp_code_enc: encrypt(otp.code) }, dedupeKey: `otp:${sessionId}` });
    } else {
      await queueSms(tx, { orgId: l.request.organisationId, template: "otp", toPhone: l.recipient.phone!, contractId: l.contract.id, recipientId: l.recipient.id, vars: { code_enc: encrypt(otp.code), minutes: String(s.signing.otpTtlMinutes) }, dedupeKey: `otp:${sessionId}` });
    }
    await audit(tx, { organisationId: l.request.organisationId, contractId: l.contract.id, recipientId: l.recipient.id, eventType: "otp.requested", ctx, metadata: { channel } });
  });
  return { channel, sentTo: channel === "EMAIL" ? maskEmail(l.recipient.email) : maskPhone(l.recipient.phone!), cooldownSeconds: OTP_COOLDOWN_SECONDS };
}

export async function verifyOtp(l: Loaded, cookie: string | undefined, code: string, ctx: RequestContext) {
  assertActive(l); assertSession(l, cookie);
  await rateLimit("otpVerifyIp", ctx.ip ?? "unknown");
  if (!/^\d{6}$/.test(code)) throw new AppError("validation_failed", "Enter the 6-digit code.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from signature_requests where id = ${l.request.id} for update`);
    const [o] = await tx.select().from(schema.otpSessions).where(and(eq(schema.otpSessions.signatureRequestId, l.request.id), isNull(schema.otpSessions.consumedAt))).orderBy(desc(schema.otpSessions.createdAt)).limit(1);
    const a = { organisationId: l.request.organisationId, contractId: l.contract.id, recipientId: l.recipient.id, ctx };
    if (!o) throw new AppError("bad_request", "Request a new code first.");
    if (o.expiresAt < new Date()) throw new AppError("gone", "That code has expired. Request a new one.");
    if (o.attempts >= o.maxAttempts) { await audit(tx, { ...a, eventType: "otp.locked" }); throw new AppError("rate_limited", "Too many wrong codes. Request a new code to try again."); }
    const ok = safeEqual(hashOtp(code, o.id), o.codeHash);
    // Attempts are counted atomically so parallel guesses cannot exceed the cap.
    const bumped = await tx.update(schema.otpSessions).set({ attempts: sql`${schema.otpSessions.attempts} + 1`, consumedAt: ok ? new Date() : null }).where(and(eq(schema.otpSessions.id, o.id), isNull(schema.otpSessions.consumedAt), sql`${schema.otpSessions.attempts} < ${schema.otpSessions.maxAttempts}`)).returning({ attempts: schema.otpSessions.attempts });
    if (!bumped.length) throw new AppError("rate_limited", "Too many wrong codes. Request a new code to try again.");
    if (!ok) {
      await audit(tx, { ...a, eventType: "otp.failed", metadata: { attemptsLeft: o.maxAttempts - bumped[0]!.attempts } });
      log.security("otp_failed", { requestId: l.request.id, ip: ctx.ip });
      return { verified: false as const, attemptsLeft: o.maxAttempts - bumped[0]!.attempts };
    }
    await tx.update(schema.signatureRequests).set({ verifiedAt: new Date() }).where(eq(schema.signatureRequests.id, l.request.id));
    await audit(tx, { ...a, eventType: "otp.verified", metadata: { channel: o.channel } });
    return { verified: true as const };
  });
}

export async function verifyPasscode(l: Loaded, cookie: string | undefined, passcode: string, ctx: RequestContext) {
  assertActive(l); assertSession(l, cookie);
  if (l.recipient.authLevel !== "PASSCODE") throw new AppError("bad_request", "This request does not use a passcode.");
  await rateLimit("emailVerify", l.request.id);
  const ok = await verifyPassword(l.recipient.passcodeHash, passcode);
  await db.transaction(async (tx) => {
    if (ok) await tx.update(schema.signatureRequests).set({ verifiedAt: new Date() }).where(eq(schema.signatureRequests.id, l.request.id));
    await audit(tx, { organisationId: l.request.organisationId, contractId: l.contract.id, recipientId: l.recipient.id, eventType: ok ? "passcode.verified" : "passcode.failed", ctx });
  });
  if (!ok) throw new AppError("validation_failed", "That passcode is not correct.");
  return { verified: true as const };
}

/** ACCOUNT level: the signed-in Bilit.event E-Sign user must own the recipient email. */
export async function verifyAccount(l: Loaded, cookie: string | undefined, userEmail: string | null, ctx: RequestContext) {
  assertActive(l); assertSession(l, cookie);
  if (l.recipient.authLevel !== "ACCOUNT") throw new AppError("bad_request", "This request does not use account sign-in.");
  if (!userEmail || userEmail.toLowerCase() !== l.recipient.email.toLowerCase()) throw new AppError("unauthenticated", `Sign in with ${maskEmail(l.recipient.email)} to continue.`);
  await db.transaction(async (tx) => {
    await tx.update(schema.signatureRequests).set({ verifiedAt: new Date() }).where(eq(schema.signatureRequests.id, l.request.id));
    await audit(tx, { organisationId: l.request.organisationId, contractId: l.contract.id, recipientId: l.recipient.id, eventType: "account.verified", ctx });
  });
}

// ------------------------------------------------------------------ view model

export async function signingView(l: Loaded, locale: Locale) {
  const { contract, recipient } = l;
  const [settings, brand, allFields, allRecips, [ver], [sender]] = await Promise.all([
    getOrgSettings(l.request.organisationId), getOrgBranding(l.request.organisationId),
    db.select().from(schema.recipientFields).where(eq(schema.recipientFields.contractId, contract.id)),
    db.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contract.id), isNull(schema.recipients.deletedAt))),
    db.select().from(schema.contractVersions).where(eq(schema.contractVersions.id, contract.signingVersionId!)),
    db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, contract.createdBy)),
  ]);
  const live = liveRecipients(allRecips);
  const mine = allFields.filter((f) => f.recipientId === recipient.id);
  const others = allFields.filter((f) => f.recipientId !== recipient.id && f.filledAt);
  const acting = live.filter(isActingRow);
  const done = acting.filter((r) => r.status === "COMPLETED").length;
  const sigIds = others.map((f) => (f.value as { evidenceId?: string } | null)?.evidenceId).filter(Boolean) as string[];
  void sigIds;
  return {
    contract: { name: contract.name, reference: contract.reference, message: contract.message, expiresAt: contract.expiresAt, senderName: sender?.name ?? "", pages: ver!.pageCount, pageGeometry: ver!.pageDims, documentHash: ver!.sha256, status: contract.status },
    branding: { orgName: brand.orgName, primaryColor: brand.primaryColor, supportEmail: brand.supportEmail, supportPhone: brand.supportPhone, tagline: brand.signingPageTagline, logoUrl: brand.logoObjectId ? `/api/branding/logo/${l.request.organisationId}` : null },
    recipient: { name: recipient.name, email: recipient.email, role: recipient.role, company: recipient.company },
    fields: mine.map((f) => ({ key: f.key, type: f.type, label: f.label, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, options: f.options, validation: pickPublicValidation(f.validation), defaultValue: f.defaultValue, filled: !!f.filledAt })),
    filledByOthers: others.map((f) => ({ key: f.key, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, text: SIGNATURE_TYPES.has(f.type) ? null : textOf(f.value) })),
    consent: { required: settings.signing.consentRequired, text: settings.signing.consentText[locale] ?? settings.signing.consentText.en },
    methods: { typed: settings.signing.allowTyped, drawn: settings.signing.allowDrawn, uploaded: settings.signing.allowUploaded },
    progress: { signed: done, total: acting.length },
    otherSigners: acting.map((r) => ({ name: r.name, status: r.status === "COMPLETED" ? "signed" : r.id === recipient.id ? "you" : actionableNow(allRecips).some((x) => x.id === r.id) ? "waiting" : "later" })),
  };
}

function pickPublicValidation(v: unknown) {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["maxLength", "min", "max", "decimals", "currency", "maxBytes", "allowedMime", "pattern", "visibleWhen"]) if (k in o) out[k] = o[k];
  return out;
}
const textOf = (v: unknown) => { const x = v as { kind?: string; text?: string; checked?: boolean } | null; return x?.kind === "text" ? x.text ?? null : x?.kind === "bool" ? (x.checked ? "✓" : "") : null; };

// ------------------------------------------------------------------ submit

export type SubmitFieldInput = {
  value?: { kind: "text"; text: string } | { kind: "bool"; checked: boolean } | { kind: "attachment"; objectId: string; bytes: number; mime: string };
  signature?: { method: "TYPED" | "DRAWN" | "UPLOADED"; typedText?: string; typedFont?: string; imageDataUrl: string };
  renderedPng?: string;
};
export type SubmitInput = { consent: boolean; locale: Locale; fields: Record<string, SubmitFieldInput> };

const MAX_SIG_BYTES = 1_500_000;

export async function decodeImageDataUrl(dataUrl: string, opts: { maxBytes?: number } = {}): Promise<{ bytes: Buffer; format: "png" | "jpg" }> {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new AppError("validation_failed", "Signature images must be PNG or JPEG.");
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length > (opts.maxBytes ?? MAX_SIG_BYTES) || bytes.length < 60) throw new AppError("validation_failed", "The signature image is too large or empty.");
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (m[1] === "png" ? !isPng : !isJpg) throw new AppError("validation_failed", "The image content does not match its type.");
  if (isPng) {
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    if (w > 4000 || h > 2000 || w < 8 || h < 8) throw new AppError("validation_failed", "The signature image dimensions are not supported.");
  }
  try { const d = await PDFDocument.create(); if (isPng) await d.embedPng(bytes); else await d.embedJpg(bytes); } catch { throw new AppError("validation_failed", "The signature image could not be read. Try drawing or typing instead."); }
  return { bytes, format: isPng ? "png" : "jpg" };
}

async function putObject(tx: Tx, orgId: string, area: "signature", bytes: Buffer, contentType: string) {
  const key = objectKey(orgId, area);
  const put = await storage().put(key, bytes, contentType);
  const [o] = await tx.insert(schema.storageObjects).values({ organisationId: orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType }).returning();
  return o!;
}

const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

export async function submitSigning(token: string, cookie: string | undefined, input: SubmitInput, ctx: RequestContext) {
  const l0 = await loadByToken(token, ctx);
  await rateLimit("signingSubmit", l0.request.id);
  assertActive(l0); assertSession(l0, cookie);
  if (needsVerification(l0) !== "NONE") throw new AppError("forbidden", "Please verify your identity first.", { code: "verification_required" });

  // Pre-decode images outside the transaction (CPU/IO heavy, nothing depends on DB state).
  const images = new Map<string, { bytes: Buffer; format: "png" | "jpg" }>();
  for (const [k, f] of Object.entries(input.fields)) {
    if (f.signature) images.set(`sig:${k}`, await decodeImageDataUrl(f.signature.imageDataUrl));
    if (f.renderedPng) images.set(`txt:${k}`, await decodeImageDataUrl(f.renderedPng, { maxBytes: 400_000 }));
  }

  const result = await db.transaction(async (tx) => {
    // Serialise every state change of this contract: two people signing at once queue here and see each other's result.
    const contract = await lockContract(tx, l0.request.organisationId, l0.contract.id);
    const [request] = await tx.select().from(schema.signatureRequests).where(eq(schema.signatureRequests.id, l0.request.id));
    const [recipient] = await tx.select().from(schema.recipients).where(eq(schema.recipients.id, l0.recipient.id));
    const l: Loaded = { request: request!, recipient: recipient!, contract };
    assertActive(l); assertSession(l, cookie);
    if (needsVerification(l) !== "NONE") throw new AppError("forbidden", "Please verify your identity first.", { code: "verification_required" });
    const all = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contract.id), isNull(schema.recipients.deletedAt)));
    if (!actionableNow(all).some((r) => r.id === recipient!.id)) throw new AppError("conflict", "It is not your turn to sign yet.");

    const settings = await getOrgSettings(contract.organisationId, tx);
    if (settings.signing.consentRequired && !input.consent) throw new AppError("validation_failed", "You need to agree to sign electronically before continuing.", { code: "consent_required" });

    const rows = await tx.select().from(schema.recipientFields).where(eq(schema.recipientFields.contractId, contract.id));
    const mine = rows.filter((f) => f.recipientId === recipient!.id);
    const unknown = Object.keys(input.fields).filter((k) => !mine.some((f) => f.key === k));
    if (unknown.length) { log.security("submit_unknown_field", { requestId: request!.id, ip: ctx.ip }); throw new AppError("validation_failed", "Some fields do not belong to you."); }

    const kitFields: Field[] = mine.map(toKitField);
    const values: Record<string, FieldValue> = {};
    const auto: Record<string, FieldValue> = {};
    for (const f of mine) {
      const inp = input.fields[f.key];
      if (f.defaultValue === "@today" && (f.type === "date")) { auto[f.key] = { kind: "text", text: todayIn(settings.general.timezone) }; values[f.key] = auto[f.key]!; continue; }
      if (!inp) continue;
      if (SIGNATURE_TYPES.has(f.type)) {
        if (!inp.signature) continue;
        const m = inp.signature.method;
        if ((m === "TYPED" && !settings.signing.allowTyped) || (m === "DRAWN" && !settings.signing.allowDrawn) || (m === "UPLOADED" && !settings.signing.allowUploaded)) throw new AppError("validation_failed", "That signature method is not allowed for this contract.");
        if (m === "TYPED" && !(inp.signature.typedText ?? "").trim()) throw new AppError("validation_failed", "Type your name to sign.");
        values[f.key] = { kind: "signature", evidenceId: "pending" };
      } else if (inp.value) {
        values[f.key] = inp.value.kind === "attachment" ? { kind: "attachment", storageKey: inp.value.objectId, bytes: inp.value.bytes, mime: inp.value.mime } : inp.value;
      }
    }
    // Server-side validation of every provided value, then the completion gate for required fields.
    const problems: { key: string; code: string }[] = [];
    for (const f of kitFields) {
      const v = values[f.id];
      if (!v) continue;
      const r = validateFieldValue(f, v);
      if (!r.ok) problems.push({ key: f.id, code: r.code });
    }
    for (const f of missingRequiredFields(kitFields, values, recipient!.id)) if (!problems.some((p) => p.key === f.id)) problems.push({ key: f.id, code: "required" });
    if (problems.length) throw new AppError("validation_failed", "Some required fields are missing or invalid.", problems);

    const [version] = await tx.select().from(schema.contractVersions).where(eq(schema.contractVersions.id, contract.signingVersionId!));
    const docHash = version!.sha256;
    const consentText = settings.signing.consentText[input.locale] ?? settings.signing.consentText.en;
    const [consent] = await tx.insert(schema.consents).values({ organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, text: consentText, textHash: sha256(consentText), locale: input.locale, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null }).returning();
    await audit(tx, { organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, eventType: "consent.given", ctx, metadata: { consentId: consent!.id, locale: input.locale, textHash: consent!.textHash } });

    const sigObjects = new Map<string, string>();
    for (const f of mine) {
      const inp = input.fields[f.key];
      const v = values[f.key];
      if (!v) continue;
      let stored: Record<string, unknown>;
      if (v.kind === "signature") {
        const s = inp!.signature!;
        const img = images.get(`sig:${f.key}`)!;
        const imgKey = sha256(img.bytes);
        let objId = sigObjects.get(imgKey);
        if (!objId) { objId = (await putObject(tx, contract.organisationId, "signature", img.bytes, img.format === "png" ? "image/png" : "image/jpeg")).id; sigObjects.set(imgKey, objId); }
        const method = f.type === "initials" ? "INITIALS" : s.method;
        const [sig] = await tx.insert(schema.signatures).values({
          organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, fieldId: f.id, method, typedText: s.method === "TYPED" ? s.typedText!.trim().slice(0, 100) : null, typedFont: s.typedFont?.slice(0, 40) ?? null,
          imageObjectId: objId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, device: ctx.device ?? {}, documentHash: docHash, signingSessionId: request!.id, authMethod: recipient!.authLevel,
        }).returning();
        stored = { kind: "signature", evidenceId: sig!.id, method, imageObjectId: objId };
        await audit(tx, { organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, eventType: "signature.applied", ctx, documentHash: docHash, metadata: { fieldKey: f.key, method, signatureId: sig!.id } });
      } else if (v.kind === "text") {
        stored = { kind: "text", text: v.text.trim() };
        if (TEXTUAL_TYPES.has(f.type) && !isWinAnsi(v.text)) {
          const img = images.get(`txt:${f.key}`);
          if (!img) throw new AppError("validation_failed", `The text in “${f.label || f.key}” uses characters that need a rendered image. Reload the page and try again.`);
          stored.imageObjectId = (await putObject(tx, contract.organisationId, "signature", img.bytes, "image/png")).id;
        }
      } else if (v.kind === "attachment") {
        const [o] = await tx.select().from(schema.storageObjects).where(and(eq(schema.storageObjects.id, v.storageKey), eq(schema.storageObjects.organisationId, contract.organisationId)));
        if (!o) throw new AppError("validation_failed", "The attachment could not be found. Upload it again.");
        stored = { kind: "attachment", objectId: o.id, bytes: o.sizeBytes, mime: o.contentType };
      } else stored = { kind: "bool", checked: v.checked };
      await tx.update(schema.recipientFields).set({ value: stored, filledAt: new Date() }).where(eq(schema.recipientFields.id, f.id));
      if (v.kind !== "signature") await audit(tx, { organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, eventType: "field.completed", ctx, metadata: { fieldKey: f.key, type: f.type } });
    }

    await tx.update(schema.recipients).set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() }).where(eq(schema.recipients.id, recipient!.id));
    await tx.update(schema.signatureRequests).set({ status: "USED" }).where(eq(schema.signatureRequests.id, request!.id));
    await audit(tx, { organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, eventType: "recipient.completed", ctx, documentHash: docHash });
    await emitWebhook(tx, contract.organisationId, "recipient.completed", { contractId: contract.id, reference: contract.reference, recipientId: recipient!.id, email: recipient!.email }, `recipient.completed:${recipient!.id}`);
    await emitWebhook(tx, contract.organisationId, "contract.signed", { contractId: contract.id, reference: contract.reference, recipientId: recipient!.id, signer: recipient!.name }, `contract.signed:${recipient!.id}`);
    await notifyUsers(tx, contract.organisationId, await contractStakeholders(tx, contract.organisationId, contract.createdBy), "contract.signed", contract.id, { contractName: contract.name, reference: contract.reference, by: recipient!.name });
    if (settings.notifications.notifySenderOnSign) await mailSender(tx, contract, "signer_completed", { signer_name: recipient!.name }, `signed:${recipient!.id}`);

    // Route onward or finish.
    const fresh = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contract.id), isNull(schema.recipients.deletedAt)));
    if (everyoneRequiredSigned(fresh)) {
      // Signing is now locked: any optional signer who has not signed loses their link. Final PDF is built by the finalize job.
      await tx.update(schema.signatureRequests).set({ status: "REVOKED", revokedAt: new Date() }).where(and(eq(schema.signatureRequests.contractId, contract.id), eq(schema.signatureRequests.status, "ACTIVE")));
      await audit(tx, { organisationId: contract.organisationId, contractId: contract.id, eventType: "signing.locked", ctx, documentHash: docHash });
      await enqueue(tx, QUEUES.finalize, { contractId: contract.id }, { singletonKey: `finalize:${contract.id}` });
      return { contractComplete: true, next: [] as string[] };
    }
    const blocked = blockedBy(fresh);
    if (blocked) return { contractComplete: false, next: [] as string[] };
    const nextRows = actionableNow(fresh).filter((r) => r.status === "WAITING");
    if (nextRows.length) await inviteRecipients(tx, contract, nextRows, contract.createdBy, "invite");
    const anyViewed = actionableNow(fresh).some((r) => r.viewedAt);
    const target = anyViewed ? "PARTIALLY_SIGNED" : "AWAITING_SIGNATURE";
    const fromRow = await lockContract(tx, contract.organisationId, contract.id);
    if (fromRow.status !== target && !(fromRow.status === "PARTIALLY_SIGNED" && target === "PARTIALLY_SIGNED")) await transition(tx, { orgId: contract.organisationId, ctx }, fromRow, target, {});
    return { contractComplete: false, next: nextRows.map((r) => r.name) };
  });
  return result;
}

export async function declineSigning(token: string, cookie: string | undefined, reason: string, ctx: RequestContext) {
  const l0 = await loadByToken(token, ctx);
  assertActive(l0); assertSession(l0, cookie);
  await db.transaction(async (tx) => {
    const contract = await lockContract(tx, l0.request.organisationId, l0.contract.id);
    const [recipient] = await tx.select().from(schema.recipients).where(eq(schema.recipients.id, l0.recipient.id));
    const [request] = await tx.select().from(schema.signatureRequests).where(eq(schema.signatureRequests.id, l0.request.id));
    assertActive({ request: request!, recipient: recipient!, contract });
    await tx.update(schema.recipients).set({ status: "DECLINED", declinedAt: new Date(), declineReason: reason.slice(0, 500) }).where(eq(schema.recipients.id, recipient!.id));
    await tx.update(schema.signatureRequests).set({ status: "USED" }).where(eq(schema.signatureRequests.id, request!.id));
    await audit(tx, { organisationId: contract.organisationId, contractId: contract.id, recipientId: recipient!.id, eventType: "contract.declined", ctx, metadata: { reason: reason.slice(0, 500), required: recipient!.required } });
    if (recipient!.required && isActingRow(recipient!)) {
      await tx.update(schema.signatureRequests).set({ status: "REVOKED", revokedAt: new Date() }).where(and(eq(schema.signatureRequests.contractId, contract.id), eq(schema.signatureRequests.status, "ACTIVE")));
      await transition(tx, { orgId: contract.organisationId, ctx }, contract, "DECLINED", { reason });
      await notifyUsers(tx, contract.organisationId, await contractStakeholders(tx, contract.organisationId, contract.createdBy), "contract.declined", contract.id, { contractName: contract.name, reference: contract.reference, by: recipient!.name, reason });
      await mailSender(tx, contract, "declined", { signer_name: recipient!.name, decline_reason: reason || "—" }, `declined:${recipient!.id}`);
      await emitWebhook(tx, contract.organisationId, "contract.declined", { contractId: contract.id, reference: contract.reference, recipientId: recipient!.id, reason }, `contract.declined:${contract.id}`);
    }
  });
}

export { inArray, asc };
