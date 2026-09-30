import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { newSigningRequestSecrets, randomId, sha256 } from "../crypto";
import { AppError, notFound } from "../errors";
import { emitWebhook } from "../webhooks/events";
import { contractStakeholders, notifyUsers } from "../notifications";
import { queueEmail } from "../messaging/email";
import { queueSms, smsAvailable } from "../messaging/sms";
import { getOrgBranding, getOrgSettings } from "../settings";
import { rateLimit } from "../rate-limit";
import { hashPassword } from "../auth/password";
import { addContractVersion } from "../documents";
import { assertTransition, isInFlight, type ContractStatus } from "./state-machine";
import { actionableNow, isActingRow, liveRecipients, planIssues } from "./routing";
import { prepareField, SIGNATURE_TYPES, type PreparedField } from "./fields";
import type { Locale } from "../messaging/templates";

export type Actor = { orgId: string; userId: string; ctx: RequestContext };
type Contract = typeof schema.contracts.$inferSelect;
type Recipient = typeof schema.recipients.$inferSelect;

const EDITABLE: ContractStatus[] = ["DRAFT", "READY_TO_SEND"];
const fmtDate = (d: Date, tz: string, locale: string) => new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", { dateStyle: "long", timeZone: tz }).format(d);

// ---------------------------------------------------------------- access

/** Row-lock a contract, scoped to the organisation. A contract in another tenant is indistinguishable from a missing one. */
export async function lockContract(tx: Tx, orgId: string, id: string): Promise<Contract> {
  const rows = await tx.execute<{ id: string }>(sql`select id from contracts where id = ${id} and organisation_id = ${orgId} and deleted_at is null for update`);
  if (!rows.rows[0]) throw notFound("Contract");
  const [c] = await tx.select().from(schema.contracts).where(eq(schema.contracts.id, id));
  return c!;
}

export async function getContractRow(orgId: string, id: string): Promise<Contract> {
  const [c] = await db.select().from(schema.contracts).where(and(eq(schema.contracts.id, id), eq(schema.contracts.organisationId, orgId), isNull(schema.contracts.deletedAt)));
  if (!c) throw notFound("Contract");
  return c;
}

const assertEditable = (c: Contract) => {
  if (!EDITABLE.includes(c.status)) throw new AppError("invalid_state", "This contract has already been sent and can no longer be edited. Create a new version or cancel it.");
};

// ---------------------------------------------------------------- creation

async function nextReference(tx: Tx, orgId: string): Promise<string> {
  const s = await getOrgSettings(orgId, tx);
  let n: number;
  if (s.general.referenceScope === "global") {
    const r = await tx.execute<{ n: string }>(sql`select nextval('contract_global_seq')::text as n`);
    n = Number(r.rows[0]!.n);
  } else {
    const r = await tx.execute<{ n: number }>(sql`update organisations set contract_seq = contract_seq + 1 where id = ${orgId} returning contract_seq as n`);
    n = r.rows[0]!.n;
  }
  return `${s.general.referencePrefix}-${new Date().getUTCFullYear()}-${String(n).padStart(6, "0")}`;
}

export type CreateContractInput = { name: string; contractType?: string; message?: string | null; metadata?: Record<string, unknown>; signingOrder?: "SEQUENTIAL" | "PARALLEL"; expiresAt?: Date | null; templateVersionId?: string | null };

export async function createContract(tx: Tx, a: Actor, input: CreateContractInput) {
  const s = await getOrgSettings(a.orgId, tx);
  const reference = await nextReference(tx, a.orgId);
  const [c] = await tx.insert(schema.contracts).values({
    organisationId: a.orgId, reference, name: input.name.trim(), contractType: input.contractType ?? "general", createdBy: a.userId, message: input.message ?? null,
    metadata: input.metadata ?? {}, signingOrder: input.signingOrder ?? s.signing.defaultSigningOrder, expiresAt: input.expiresAt ?? null, templateVersionId: input.templateVersionId ?? null,
  }).returning();
  await refreshSearchText(tx, c!.id);
  await audit(tx, { organisationId: a.orgId, contractId: c!.id, userId: a.userId, eventType: "contract.created", ctx: a.ctx, metadata: { reference, name: c!.name } });
  await emitWebhook(tx, a.orgId, "contract.created", { contractId: c!.id, reference, name: c!.name }, `contract.created:${c!.id}`);
  return c!;
}

export async function updateContract(tx: Tx, a: Actor, id: string, patch: Partial<{ name: string; contractType: string; message: string | null; metadata: Record<string, unknown>; signingOrder: "SEQUENTIAL" | "PARALLEL"; expiresAt: Date | null }>, expectedRev?: number) {
  const c = await lockContract(tx, a.orgId, id);
  assertEditable(c);
  if (expectedRev !== undefined && expectedRev !== c.rev) throw new AppError("conflict", "This contract was changed by someone else. Reload to see the latest version.");
  const [u] = await tx.update(schema.contracts).set({ ...patch, name: patch.name?.trim() ?? c.name, rev: c.rev + 1, updatedAt: new Date() }).where(eq(schema.contracts.id, id)).returning();
  await refreshSearchText(tx, id);
  await audit(tx, { organisationId: a.orgId, contractId: id, userId: a.userId, eventType: "contract.edited", ctx: a.ctx, metadata: { fields: Object.keys(patch) } });
  return u!;
}

export async function uploadVersion(tx: Tx, a: Actor, id: string, bytes: Buffer, reason?: string) {
  const c = await lockContract(tx, a.orgId, id);
  assertEditable(c);
  const ver = await addContractVersion(tx, { orgId: a.orgId, contractId: id, userId: a.userId, bytes, reason, ctx: a.ctx });
  const fields = await tx.select({ key: schema.recipientFields.key, page: schema.recipientFields.page }).from(schema.recipientFields).where(eq(schema.recipientFields.contractId, id));
  const outside = fields.filter((f) => f.page >= ver.pageCount);
  if (outside.length) throw new AppError("validation_failed", `The new document has ${ver.pageCount} page(s), but ${outside.length} field(s) are placed on later pages. Move or delete them first.`);
  await tx.update(schema.contracts).set({ currentVersionId: ver.id, rev: c.rev + 1, updatedAt: new Date() }).where(eq(schema.contracts.id, id));
  return ver;
}

/** Copy a contract's setup (document, recipients, fields) into a fresh draft. Signing evidence is never copied. */
export async function duplicateContract(tx: Tx, a: Actor, id: string) {
  const src = await getContractRow(a.orgId, id);
  const copy = await createContract(tx, a, { name: `${src.name} (copy)`, contractType: src.contractType, message: src.message, metadata: src.metadata as Record<string, unknown>, signingOrder: src.signingOrder as "SEQUENTIAL" | "PARALLEL" });
  const versionId = src.signingVersionId ?? src.currentVersionId;
  if (versionId) {
    const [v] = await tx.select().from(schema.contractVersions).where(and(eq(schema.contractVersions.id, versionId), eq(schema.contractVersions.organisationId, a.orgId)));
    if (v) {
      const [o] = await tx.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, v.storageObjectId));
      const { storage } = await import("../storage");
      const bytes = await storage().getBuffer(o!.key);
      const nv = await addContractVersion(tx, { orgId: a.orgId, contractId: copy.id, userId: a.userId, bytes, reason: `Duplicated from ${src.reference}`, ctx: a.ctx });
      await tx.update(schema.contracts).set({ currentVersionId: nv.id }).where(eq(schema.contracts.id, copy.id));
    }
  }
  const recips = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, id), isNull(schema.recipients.deletedAt), sql`${schema.recipients.status} <> 'REMOVED'`));
  const map = new Map<string, string>();
  for (const r of recips) {
    const [n] = await tx.insert(schema.recipients).values({ contractId: copy.id, organisationId: a.orgId, name: r.name, email: r.email, phone: r.phone, company: r.company, role: r.role, signingOrder: r.signingOrder, required: r.required, internal: r.internal, authLevel: r.authLevel, passcodeHash: r.passcodeHash, smsConsent: r.smsConsent }).returning({ id: schema.recipients.id });
    map.set(r.id, n!.id);
  }
  const fields = await tx.select().from(schema.recipientFields).where(eq(schema.recipientFields.contractId, id));
  if (fields.length) {
    await tx.insert(schema.recipientFields).values(fields.filter((f) => map.has(f.recipientId)).map((f) => ({ contractId: copy.id, organisationId: a.orgId, recipientId: map.get(f.recipientId)!, key: f.key, type: f.type, label: f.label, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, defaultValue: f.defaultValue, options: f.options, validation: f.validation })));
  }
  await audit(tx, { organisationId: a.orgId, contractId: copy.id, userId: a.userId, eventType: "contract.duplicated", ctx: a.ctx, metadata: { from: src.id, fromReference: src.reference } });
  return copy;
}

// ---------------------------------------------------------------- recipients

export type RecipientInput = { name: string; email: string; phone?: string | null; company?: string | null; role?: "SIGNER" | "CC" | "WITNESS" | "APPROVER"; signingOrder?: number; required?: boolean; internal?: boolean; authLevel?: "LINK" | "EMAIL_OTP" | "SMS_OTP" | "PASSCODE" | "ACCOUNT"; passcode?: string | null; smsConsent?: boolean };

async function checkRecipientAuth(orgId: string, i: { authLevel?: string; phone?: string | null; passcode?: string | null }) {
  if (i.authLevel === "SMS_OTP" && !i.phone) throw new AppError("validation_failed", "A mobile number is required for SMS verification.");
  if (i.authLevel === "SMS_OTP" && !(await smsAvailable(orgId))) throw new AppError("config_missing", "SMS verification needs an SMS provider. Configure one in Settings → SMS or choose email verification.");
  if (i.authLevel === "PASSCODE" && !i.passcode) throw new AppError("validation_failed", "Choose a passcode for this recipient.");
  if (i.passcode && i.passcode.length < 4) throw new AppError("validation_failed", "The passcode must be at least 4 characters.");
}

export async function addRecipient(tx: Tx, a: Actor, contractId: string, input: RecipientInput) {
  const c = await lockContract(tx, a.orgId, contractId);
  assertEditable(c);
  await checkRecipientAuth(a.orgId, input);
  const s = await getOrgSettings(a.orgId, tx);
  const existing = await tx.select({ n: sql<number>`count(*)::int`, max: sql<number>`coalesce(max(${schema.recipients.signingOrder}),0)::int` }).from(schema.recipients).where(and(eq(schema.recipients.contractId, contractId), isNull(schema.recipients.deletedAt)));
  if ((existing[0]?.n ?? 0) >= 50) throw new AppError("validation_failed", "A contract can have at most 50 recipients.");
  const role = input.role ?? "SIGNER";
  const order = input.signingOrder ?? (c.signingOrder === "PARALLEL" ? 1 : (existing[0]?.max ?? 0) + 1);
  const [r] = await tx.insert(schema.recipients).values({
    contractId, organisationId: a.orgId, name: input.name.trim(), email: input.email.trim().toLowerCase(), phone: input.phone || null, company: input.company || null,
    role, signingOrder: order, required: role === "CC" ? false : input.required ?? true, internal: input.internal ?? false, authLevel: input.authLevel ?? s.signing.defaultAuthLevel,
    passcodeHash: input.passcode ? await hashPassword(input.passcode) : null, smsConsent: input.smsConsent ?? false,
  }).returning();
  await refreshSearchText(tx, contractId);
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, recipientId: r!.id, eventType: "recipient.added", ctx: a.ctx, metadata: { role, order, email: r!.email } });
  await emitWebhook(tx, a.orgId, "recipient.added", { contractId, recipientId: r!.id, role, email: r!.email }, `recipient.added:${r!.id}`);
  return r!;
}

export async function updateRecipient(tx: Tx, a: Actor, contractId: string, recipientId: string, patch: Partial<RecipientInput>) {
  const c = await lockContract(tx, a.orgId, contractId);
  assertEditable(c);
  const [r] = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.id, recipientId), eq(schema.recipients.contractId, contractId), eq(schema.recipients.organisationId, a.orgId), isNull(schema.recipients.deletedAt)));
  if (!r) throw notFound("Recipient");
  await checkRecipientAuth(a.orgId, { authLevel: patch.authLevel ?? r.authLevel, phone: patch.phone === undefined ? r.phone : patch.phone, passcode: patch.passcode ?? (r.passcodeHash ? "keep" : null) });
  const role = patch.role ?? r.role;
  const [u] = await tx.update(schema.recipients).set({
    name: patch.name?.trim() ?? r.name, email: patch.email ? patch.email.trim().toLowerCase() : r.email, phone: patch.phone === undefined ? r.phone : patch.phone || null,
    company: patch.company === undefined ? r.company : patch.company || null, role, signingOrder: patch.signingOrder ?? r.signingOrder,
    required: role === "CC" ? false : patch.required ?? r.required, internal: patch.internal ?? r.internal, authLevel: patch.authLevel ?? r.authLevel,
    passcodeHash: patch.passcode ? await hashPassword(patch.passcode) : r.passcodeHash, smsConsent: patch.smsConsent ?? r.smsConsent, updatedAt: new Date(),
  }).where(eq(schema.recipients.id, recipientId)).returning();
  await refreshSearchText(tx, contractId);
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, recipientId, eventType: "recipient.edited", ctx: a.ctx, metadata: { fields: Object.keys(patch).filter((k) => k !== "passcode") } });
  return u!;
}

export async function removeRecipient(tx: Tx, a: Actor, contractId: string, recipientId: string) {
  const c = await lockContract(tx, a.orgId, contractId);
  assertEditable(c);
  const [r] = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.id, recipientId), eq(schema.recipients.contractId, contractId), eq(schema.recipients.organisationId, a.orgId), isNull(schema.recipients.deletedAt)));
  if (!r) throw notFound("Recipient");
  await tx.delete(schema.recipientFields).where(eq(schema.recipientFields.recipientId, recipientId));
  await tx.update(schema.recipients).set({ deletedAt: new Date(), status: "REMOVED" }).where(eq(schema.recipients.id, recipientId));
  await refreshSearchText(tx, contractId);
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, recipientId, eventType: "recipient.removed", ctx: a.ctx, metadata: { email: r.email } });
}

// ---------------------------------------------------------------- fields

/** Replace the whole field layout atomically (the editor autosaves the full set). Only allowed before sending. */
export async function saveFields(tx: Tx, a: Actor, contractId: string, raw: unknown[]) {
  const c = await lockContract(tx, a.orgId, contractId);
  assertEditable(c);
  if (!c.currentVersionId) throw new AppError("invalid_state", "Upload a document before placing fields.");
  if (raw.length > 500) throw new AppError("validation_failed", "A contract can have at most 500 fields.");
  const [ver] = await tx.select({ pages: schema.contractVersions.pageCount }).from(schema.contractVersions).where(eq(schema.contractVersions.id, c.currentVersionId));
  const recips = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contractId), isNull(schema.recipients.deletedAt)));
  const byId = new Map(recips.map((r) => [r.id, r]));
  let prepared: PreparedField[];
  try { prepared = raw.map((f) => prepareField(f, ver!.pages)); } catch (e) {
    if (e instanceof RangeError) throw new AppError("validation_failed", e.message);
    throw e;
  }
  const keys = new Set<string>();
  for (const f of prepared) {
    if (keys.has(f.key)) throw new AppError("validation_failed", `Duplicate field id "${f.key}".`);
    keys.add(f.key);
    const r = byId.get(f.recipientId);
    if (!r) throw new AppError("validation_failed", `Field "${f.key}" is assigned to an unknown recipient.`);
    if (r.role === "CC") throw new AppError("validation_failed", "CC recipients cannot have fields.");
  }
  await tx.delete(schema.recipientFields).where(eq(schema.recipientFields.contractId, contractId));
  if (prepared.length) await tx.insert(schema.recipientFields).values(prepared.map((f) => ({ ...f, contractId, organisationId: a.orgId })));
  await tx.update(schema.contracts).set({ rev: c.rev + 1, updatedAt: new Date() }).where(eq(schema.contracts.id, contractId));
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, eventType: "fields.saved", ctx: a.ctx, metadata: { count: prepared.length } });
  return prepared.length;
}

// ---------------------------------------------------------------- readiness / send

export type ReadinessIssue = { code: string; message: string; recipientId?: string };

export async function readiness(tx: Pick<typeof db, "select">, contractId: string): Promise<ReadinessIssue[]> {
  const [c] = await tx.select().from(schema.contracts).where(eq(schema.contracts.id, contractId));
  const issues: ReadinessIssue[] = [];
  if (!c?.currentVersionId) issues.push({ code: "no_document", message: "Upload a document." });
  const recips = liveRecipients(await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contractId), isNull(schema.recipients.deletedAt))));
  const fields = await tx.select().from(schema.recipientFields).where(eq(schema.recipientFields.contractId, contractId));
  for (const i of planIssues(recips)) {
    const msg: Record<string, string> = { duplicate_email: "The same person is listed twice in the same role.", no_acting_recipient: "Add at least one required signer.", optional_only_group: "Every signing step needs at least one required signer.", bad_order: "A recipient has an invalid signing order." };
    issues.push({ code: i.code, message: msg[i.code] ?? i.code, recipientId: i.recipientId });
  }
  for (const r of recips.filter(isActingRow)) {
    const mine = fields.filter((f) => f.recipientId === r.id);
    if (!mine.some((f) => SIGNATURE_TYPES.has(f.type))) issues.push({ code: "no_signature_field", message: `${r.name} needs at least one signature or initials field.`, recipientId: r.id });
    if (r.authLevel === "SMS_OTP" && !r.phone) issues.push({ code: "no_phone", message: `${r.name} needs a mobile number for SMS verification.`, recipientId: r.id });
  }
  return issues;
}

export async function setReady(tx: Tx, a: Actor, id: string, ready: boolean) {
  const c = await lockContract(tx, a.orgId, id);
  const to: ContractStatus = ready ? "READY_TO_SEND" : "DRAFT";
  if (c.status === to) return c;
  if (ready) {
    const issues = await readiness(tx, id);
    if (issues.length) throw new AppError("validation_failed", "This contract is not ready to send yet.", issues);
  }
  return transition(tx, a, c, to, {});
}

export async function transition(tx: Tx, a: { orgId: string; userId?: string | null; ctx?: RequestContext }, c: Contract, to: ContractStatus, extra: Partial<typeof schema.contracts.$inferInsert> & { reason?: string }) {
  assertTransition(c.status, to);
  const { reason, ...set } = extra;
  const [u] = await tx.update(schema.contracts).set({ ...set, status: to, rev: c.rev + 1, updatedAt: new Date() }).where(eq(schema.contracts.id, c.id)).returning();
  await audit(tx, { organisationId: a.orgId, contractId: c.id, userId: a.userId ?? null, eventType: `contract.status.${to.toLowerCase()}`, ctx: a.ctx, metadata: { from: c.status, to, reason: reason ?? null } });
  return u!;
}

/** Create (or rotate) the signing request for a recipient. Any previously active request is revoked in the same transaction. */
export async function issueSigningRequest(tx: Tx, c: Contract, r: Recipient, ttlHours: number) {
  await tx.update(schema.signatureRequests).set({ status: "REVOKED", revokedAt: new Date() }).where(and(eq(schema.signatureRequests.recipientId, r.id), eq(schema.signatureRequests.status, "ACTIVE")));
  const id = crypto.randomUUID();
  const { nonce, tokenHash } = newSigningRequestSecrets(id);
  const exp = new Date(Math.min(Date.now() + ttlHours * 3600_000, c.expiresAt?.getTime() ?? Infinity));
  await tx.insert(schema.signatureRequests).values({ id, organisationId: c.organisationId, contractId: c.id, recipientId: r.id, tokenHash, tokenNonce: nonce, expiresAt: exp });
  return id;
}

async function senderName(tx: Pick<typeof db, "select">, userId: string) {
  const [u] = await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
  return u?.name ?? "";
}

/** Invite the given actionable recipients: email (+ SMS when consented and configured). Idempotent per (request). */
export async function inviteRecipients(tx: Tx, c: Contract, recips: Recipient[], senderUserId: string, kind: "invite" | "reminder" = "invite", seq = 0) {
  const s = await getOrgSettings(c.organisationId, tx);
  const brand = await getOrgBranding(c.organisationId);
  const sender = await senderName(tx, c.createdBy);
  void senderUserId;
  const smsOk = await smsAvailable(c.organisationId);
  for (const r of recips) {
    // Reminders reuse the live link (no rotation, so the original email keeps working); invitations/resends always rotate.
    const live = kind === "reminder" ? (await tx.select({ id: schema.signatureRequests.id }).from(schema.signatureRequests).where(and(eq(schema.signatureRequests.recipientId, r.id), eq(schema.signatureRequests.status, "ACTIVE"))))[0] : undefined;
    const reqId = live?.id ?? (await issueSigningRequest(tx, c, r, s.signing.tokenTtlHours));
    await tx.update(schema.recipients).set({ status: r.status === "VIEWED" ? "VIEWED" : "SENT", updatedAt: new Date() }).where(eq(schema.recipients.id, r.id));
    const vars = { recipient_name: r.name, sender_name: sender, contract_name: c.name, contract_reference: c.reference, message: c.message ?? "", expiry_date: c.expiresAt ? fmtDate(c.expiresAt, s.general.timezone, s.general.locale) : "", organisation_name: brand.orgName };
    await queueEmail(tx, { orgId: c.organisationId, template: kind === "invite" ? "signature_requested" : "reminder", toEmail: r.email, contractId: c.id, recipientId: r.id, vars, signatureRequestId: reqId, dedupeKey: `${kind}:${reqId}:${seq}` });
    if (smsOk && r.smsConsent && r.phone) {
      await queueSms(tx, { orgId: c.organisationId, template: kind === "invite" ? "invite" : "reminder", toPhone: r.phone, contractId: c.id, recipientId: r.id, signatureRequestId: reqId, vars: { sender, contract: c.name, expiry: c.expiresAt ? fmtDate(c.expiresAt, s.general.timezone, s.general.locale) : "" }, dedupeKey: `sms:${kind}:${reqId}:${seq}` });
    }
    await audit(tx, { organisationId: c.organisationId, contractId: c.id, recipientId: r.id, userId: senderUserId, eventType: kind === "invite" ? "signing_request.created" : "reminder.sent", metadata: { requestId: reqId } });
  }
}

/** Idempotent replay store: same key => same stored response, no repeated side effects. */
export async function withIdempotency<T>(tx: Tx, orgId: string, scope: string, key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const k = sha256(`${orgId}:${key}`);
  const ins = await tx.insert(schema.idempotencyKeys).values({ scope, key: k, organisationId: orgId }).onConflictDoNothing().returning({ k: schema.idempotencyKeys.key });
  if (!ins.length) {
    const [row] = await tx.select().from(schema.idempotencyKeys).where(and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.key, k)));
    if (row?.response) return row.response as T;
    throw new AppError("conflict", "This request is already being processed.");
  }
  const out = await fn();
  await tx.update(schema.idempotencyKeys).set({ response: out as never }).where(and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.key, k)));
  return out;
}

export async function sendContract(tx: Tx, a: Actor, id: string, opts: { expiresAt?: Date | null; idempotencyKey?: string | null } = {}) {
  return withIdempotency(tx, a.orgId, "contract.send", opts.idempotencyKey, async () => {
    const c = await lockContract(tx, a.orgId, id);
    if (!EDITABLE.includes(c.status)) throw new AppError("invalid_state", "This contract has already been sent.");
    const issues = await readiness(tx, id);
    if (issues.length) throw new AppError("validation_failed", "This contract is not ready to send yet.", issues);
    const s = await getOrgSettings(a.orgId, tx);
    await rateLimit("sendContract", a.orgId, s.rateLimits.sendContractPerHour ? { limit: s.rateLimits.sendContractPerHour } : undefined);

    const expiresAt = opts.expiresAt ?? c.expiresAt ?? new Date(Date.now() + s.signing.defaultExpiryDays * 86400_000);
    if (expiresAt.getTime() <= Date.now() + 60_000) throw new AppError("validation_failed", "The expiry date must be in the future.");

    // Freeze: from here on the signing version can never change (also enforced by a DB trigger).
    await tx.update(schema.contractVersions).set({ locked: true }).where(eq(schema.contractVersions.id, c.currentVersionId!));
    const [ver] = await tx.select().from(schema.contractVersions).where(eq(schema.contractVersions.id, c.currentVersionId!));
    const recips = liveRecipients(await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, id), isNull(schema.recipients.deletedAt))));
    await tx.update(schema.recipients).set({ status: "WAITING" }).where(and(eq(schema.recipients.contractId, id), isNull(schema.recipients.deletedAt)));
    let staged = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, id), isNull(schema.recipients.deletedAt)));
    const first = actionableNow(staged);

    // DRAFT -> READY_TO_SEND -> SENT: both steps are real transitions and both are audited.
    const ready = c.status === "DRAFT" ? await transition(tx, a, c, "READY_TO_SEND", {}) : c;
    const sent = await transition(tx, a, ready, "SENT", { sentAt: new Date(), expiresAt, signingVersionId: ver!.id, verificationId: c.verificationId ?? randomId(12) });
    await audit(tx, { organisationId: a.orgId, contractId: id, userId: a.userId, eventType: "contract.sent", ctx: a.ctx, documentHash: ver!.sha256, metadata: { recipients: recips.length, expiresAt: expiresAt.toISOString() } });
    await inviteRecipients(tx, sent, first, a.userId);

    // CC and sender get an FYI copy.
    const sender = await senderName(tx, c.createdBy);
    const brand = await getOrgBranding(a.orgId);
    const ccs = staged.filter((r) => r.role === "CC");
    for (const cc of ccs) {
      await queueEmail(tx, { orgId: a.orgId, template: "contract_sent", toEmail: cc.email, contractId: id, recipientId: cc.id, vars: { recipient_name: cc.name, sender_name: sender, contract_name: c.name, contract_reference: c.reference, organisation_name: brand.orgName }, dedupeKey: `contract_sent:${id}:${cc.id}` });
    }
    await emitWebhook(tx, a.orgId, "contract.sent", { contractId: id, reference: c.reference, documentHash: ver!.sha256, expiresAt: expiresAt.toISOString() }, `contract.sent:${id}`);
    staged = [];
    return { id, status: sent.status, sentAt: sent.sentAt, expiresAt };
  });
}

// ---------------------------------------------------------------- admin lifecycle

async function revokeAllRequests(tx: Tx, contractId: string) {
  await tx.update(schema.signatureRequests).set({ status: "REVOKED", revokedAt: new Date() }).where(and(eq(schema.signatureRequests.contractId, contractId), eq(schema.signatureRequests.status, "ACTIVE")));
}

async function notifyRecipients(tx: Tx, c: Contract, template: "cancelled" | "voided" | "expired", reason?: string) {
  const recips = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, c.id), isNull(schema.recipients.deletedAt)));
  const brand = await getOrgBranding(c.organisationId);
  const sender = await senderName(tx, c.createdBy);
  for (const r of recips.filter((x) => ["SENT", "VIEWED", "COMPLETED", "WAITING"].includes(x.status) || x.role === "CC")) {
    await queueEmail(tx, { orgId: c.organisationId, template, toEmail: r.email, contractId: c.id, recipientId: r.id, vars: { recipient_name: r.name, sender_name: sender, contract_name: c.name, contract_reference: c.reference, organisation_name: brand.orgName, reason: reason ?? "" }, dedupeKey: `${template}:${c.id}:${r.id}` });
  }
}

export async function cancelContract(tx: Tx, a: Actor, id: string, reason?: string) {
  const c = await lockContract(tx, a.orgId, id);
  if (!(EDITABLE.includes(c.status) || isInFlight(c.status))) throw new AppError("invalid_state", "Only unsent or in-progress contracts can be cancelled.");
  await revokeAllRequests(tx, id);
  const u = await transition(tx, a, c, "CANCELLED", { reason });
  await notifyRecipients(tx, u, "cancelled", reason);
  await notifyUsers(tx, a.orgId, await contractStakeholders(tx, a.orgId, c.createdBy), "contract.cancelled", id, { contractName: c.name, reference: c.reference });
  await emitWebhook(tx, a.orgId, "contract.cancelled", { contractId: id, reference: c.reference, reason: reason ?? null }, `contract.cancelled:${id}`);
  return u;
}

export async function voidContract(tx: Tx, a: Actor, id: string, reason: string) {
  const c = await lockContract(tx, a.orgId, id);
  if (!isInFlight(c.status)) throw new AppError("invalid_state", "Only contracts that are out for signature can be voided.");
  await revokeAllRequests(tx, id);
  const u = await transition(tx, a, c, "VOIDED", { reason });
  await audit(tx, { organisationId: a.orgId, contractId: id, userId: a.userId, eventType: "admin.override.void", ctx: a.ctx, metadata: { reason } });
  await notifyRecipients(tx, u, "voided", reason);
  await emitWebhook(tx, a.orgId, "contract.voided", { contractId: id, reference: c.reference, reason }, `contract.voided:${id}`);
  return u;
}

/** Expire now (manual override or the scheduled scan). System callers pass userId null. */
export async function expireContract(tx: Tx, a: { orgId: string; userId?: string | null; ctx?: RequestContext }, id: string) {
  const c = await lockContract(tx, a.orgId, id);
  if (!isInFlight(c.status)) return c; // already resolved: nothing to do (idempotent for the scan)
  await revokeAllRequests(tx, id);
  await tx.update(schema.signatureRequests).set({ status: "EXPIRED" }).where(and(eq(schema.signatureRequests.contractId, id), eq(schema.signatureRequests.status, "REVOKED"), sql`${schema.signatureRequests.revokedAt} > now() - interval '5 seconds'`));
  const u = await transition(tx, a, c, "EXPIRED", { reason: a.userId ? "manual" : "deadline" });
  if (a.userId) await audit(tx, { organisationId: a.orgId, contractId: id, userId: a.userId, eventType: "admin.override.expire", ctx: a.ctx });
  await notifyRecipients(tx, u, "expired");
  await notifyUsers(tx, a.orgId, await contractStakeholders(tx, a.orgId, c.createdBy), "contract.expired", id, { contractName: c.name, reference: c.reference });
  await emitWebhook(tx, a.orgId, "contract.expired", { contractId: id, reference: c.reference }, `contract.expired:${id}`);
  return u;
}

export async function archiveContract(tx: Tx, a: Actor, id: string) {
  const c = await lockContract(tx, a.orgId, id);
  return transition(tx, a, c, "ARCHIVED", {});
}

export async function softDeleteContract(tx: Tx, a: Actor, id: string) {
  const c = await lockContract(tx, a.orgId, id);
  if (c.status !== "DRAFT" && c.status !== "CANCELLED") throw new AppError("invalid_state", "Only drafts and cancelled contracts can be deleted. Signed or in-flight contracts are legal records: archive or void them instead.");
  await tx.update(schema.contracts).set({ deletedAt: new Date() }).where(eq(schema.contracts.id, id));
  await audit(tx, { organisationId: a.orgId, contractId: id, userId: a.userId, eventType: "contract.deleted", ctx: a.ctx });
}

// ---------------------------------------------------------------- resend / remind / reassign

async function actionableRecipient(tx: Tx, orgId: string, contractId: string, recipientId: string) {
  const all = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contractId), eq(schema.recipients.organisationId, orgId), isNull(schema.recipients.deletedAt)));
  const r = all.find((x) => x.id === recipientId);
  if (!r) throw notFound("Recipient");
  if (!actionableNow(all).some((x) => x.id === r.id)) throw new AppError("invalid_state", "This recipient is not currently able to sign (they may have finished, or an earlier signer still needs to act).");
  return r;
}

/** Resend = rotate the link (old one dies) and send a fresh invitation. */
export async function resendToRecipient(tx: Tx, a: Actor, contractId: string, recipientId: string) {
  const c = await lockContract(tx, a.orgId, contractId);
  if (!isInFlight(c.status)) throw new AppError("invalid_state", "This contract is not out for signature.");
  const r = await actionableRecipient(tx, a.orgId, contractId, recipientId);
  const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.signatureRequests).where(eq(schema.signatureRequests.recipientId, r.id));
  await inviteRecipients(tx, c, [r], a.userId, "invite", cnt?.n ?? 1);
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, recipientId, eventType: "contract.resent", ctx: a.ctx });
}

export async function remindRecipient(tx: Tx, a: Actor, contractId: string, recipientId?: string) {
  const c = await lockContract(tx, a.orgId, contractId);
  if (!isInFlight(c.status)) throw new AppError("invalid_state", "This contract is not out for signature.");
  const all = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contractId), isNull(schema.recipients.deletedAt)));
  const targets = recipientId ? [await actionableRecipient(tx, a.orgId, contractId, recipientId)] : actionableNow(all);
  if (!targets.length) throw new AppError("invalid_state", "Nobody is waiting to sign.");
  const slotId = randomId(6);
  for (const r of targets) {
    const recent = await tx.select({ id: schema.reminders.id }).from(schema.reminders).where(and(eq(schema.reminders.recipientId, r.id), sql`${schema.reminders.sentAt} > now() - interval '1 hour'`, eq(schema.reminders.kind, "MANUAL")));
    if (recent.length) throw new AppError("rate_limited", `${r.name} was already reminded in the last hour.`);
    await tx.insert(schema.reminders).values({ organisationId: a.orgId, contractId, recipientId: r.id, kind: "MANUAL", slot: `manual:${slotId}` });
    await inviteRecipients(tx, c, [r], a.userId, "reminder", Date.now() % 1_000_000);
  }
  return targets.length;
}

export async function reassignRecipient(tx: Tx, a: Actor, contractId: string, recipientId: string, to: { name: string; email: string; phone?: string | null }) {
  const c = await lockContract(tx, a.orgId, contractId);
  if (!isInFlight(c.status)) throw new AppError("invalid_state", "This contract is not out for signature.");
  const [r] = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.id, recipientId), eq(schema.recipients.contractId, contractId), eq(schema.recipients.organisationId, a.orgId), isNull(schema.recipients.deletedAt)));
  if (!r) throw notFound("Recipient");
  if (["COMPLETED", "DECLINED", "REMOVED"].includes(r.status)) throw new AppError("invalid_state", "This recipient has already acted and cannot be reassigned.");
  await tx.update(schema.signatureRequests).set({ status: "REVOKED", revokedAt: new Date() }).where(and(eq(schema.signatureRequests.recipientId, r.id), eq(schema.signatureRequests.status, "ACTIVE")));
  const [u] = await tx.update(schema.recipients).set({ name: to.name.trim(), email: to.email.trim().toLowerCase(), phone: to.phone || null, status: r.status === "WAITING" ? "WAITING" : "SENT", viewedAt: null, updatedAt: new Date() }).where(eq(schema.recipients.id, r.id)).returning();
  await refreshSearchText(tx, contractId);
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, recipientId, eventType: "admin.override.reassign", ctx: a.ctx, metadata: { from: r.email, to: u!.email } });
  const brand = await getOrgBranding(a.orgId);
  const sender = await senderName(tx, c.createdBy);
  await queueEmail(tx, { orgId: a.orgId, template: "recipient_removed", toEmail: r.email, contractId, recipientId, vars: { recipient_name: r.name, sender_name: sender, contract_name: c.name, contract_reference: c.reference, organisation_name: brand.orgName }, dedupeKey: `recipient_removed:${recipientId}:${sha256(r.email)}` });
  if (r.status !== "WAITING") await inviteRecipients(tx, c, [u!], a.userId, "invite", Date.now() % 1_000_000);
  return u!;
}

// ---------------------------------------------------------------- reads

export async function listContractEvents(orgId: string, contractId: string) {
  await getContractRow(orgId, contractId);
  return db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.organisationId, orgId), eq(schema.auditEvents.contractId, contractId))).orderBy(asc(schema.auditEvents.seq));
}

export async function getContractDetail(orgId: string, id: string) {
  const c = await getContractRow(orgId, id);
  const [versions, recips, fields, emails, sms, downloads, cert, reminders] = await Promise.all([
    db.select().from(schema.contractVersions).where(and(eq(schema.contractVersions.contractId, id), eq(schema.contractVersions.organisationId, orgId))).orderBy(desc(schema.contractVersions.createdAt)),
    db.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, id), eq(schema.recipients.organisationId, orgId), isNull(schema.recipients.deletedAt))).orderBy(asc(schema.recipients.signingOrder), asc(schema.recipients.createdAt)),
    db.select().from(schema.recipientFields).where(and(eq(schema.recipientFields.contractId, id), eq(schema.recipientFields.organisationId, orgId))),
    db.select().from(schema.emailMessages).where(and(eq(schema.emailMessages.contractId, id), eq(schema.emailMessages.organisationId, orgId))).orderBy(desc(schema.emailMessages.createdAt)).limit(200),
    db.select().from(schema.smsMessages).where(and(eq(schema.smsMessages.contractId, id), eq(schema.smsMessages.organisationId, orgId))).orderBy(desc(schema.smsMessages.createdAt)).limit(200),
    db.select().from(schema.downloads).where(and(eq(schema.downloads.contractId, id), eq(schema.downloads.organisationId, orgId))).orderBy(desc(schema.downloads.createdAt)).limit(200),
    db.select().from(schema.completionCertificates).where(and(eq(schema.completionCertificates.contractId, id), eq(schema.completionCertificates.organisationId, orgId))),
    db.select().from(schema.reminders).where(and(eq(schema.reminders.contractId, id), eq(schema.reminders.organisationId, orgId))).orderBy(desc(schema.reminders.sentAt)),
  ]);
  const creator = (await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, c.createdBy)))[0];
  const template = c.templateVersionId ? (await db.select({ name: schema.templates.name }).from(schema.templateVersions).innerJoin(schema.templates, eq(schema.templates.id, schema.templateVersions.templateId)).where(eq(schema.templateVersions.id, c.templateVersionId)))[0] : null;
  return { contract: c, creator, template, versions, recipients: recips, fields, emails, sms, downloads, certificate: cert[0] ?? null, reminders, actionable: actionableNow(recips).map((r) => r.id) };
}

export { inArray };
export type { Locale };

/** Keep the trigram-indexed search column in step with the contract, its recipients and searchable metadata. */
export async function refreshSearchText(tx: Tx, contractId: string) {
  await tx.execute(sql`
    update contracts c set search_text = lower(concat_ws(' ', c.name, c.reference, c.contract_type,
      c.metadata->>'company', c.metadata->>'event', c.metadata->>'referenceNumber', c.metadata->>'venue',
      (select string_agg(concat_ws(' ', r.name, r.email, r.company), ' ') from recipients r where r.contract_id = c.id and r.deleted_at is null)))
    where c.id = ${contractId}`);
}
