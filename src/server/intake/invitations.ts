import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { audit, type RequestContext } from "../audit";
import { deriveIntakeToken, newIntakeSecrets } from "../crypto";
import { AppError, notFound } from "../errors";
import { hashPassword } from "../auth/password";
import { queueEmail } from "../messaging/email";
import { getOrgBranding } from "../settings";
import { FormSettings } from "./schema";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
export type InvitationRow = typeof schema.intakeInvitations.$inferSelect;

export const intakeUrl = (token: string) => `${env().APP_URL.replace(/\/$/, "")}/intake/${token}`;
export const inviteDedupeKey = (id: string) => `intake_invite:${id}`;

export async function sendInvitation(tx: Tx, a: Actor, input: { formVersionId: string; recipientName: string; recipientEmail: string; authMode?: "NONE" | "EMAIL_OTP" | "PASSCODE"; passcode?: string; expiryDays?: number; message?: string }) {
  const [v] = await tx.select().from(schema.intakeFormVersions).where(and(eq(schema.intakeFormVersions.id, input.formVersionId), eq(schema.intakeFormVersions.organisationId, a.orgId)));
  if (!v) throw notFound("Form version");
  if (!v.published) throw new AppError("invalid_state", "Publish the form before sending it.");
  const [form] = await tx.select().from(schema.intakeForms).where(eq(schema.intakeForms.id, v.formId));
  if (form!.status === "ARCHIVED") throw new AppError("invalid_state", "This form is archived.");
  const settings = FormSettings.parse(v.settings);
  const authMode = input.authMode ?? "NONE";
  if (authMode === "PASSCODE" && (!input.passcode || input.passcode.length < 6)) throw new AppError("validation_failed", "Choose a passcode of at least 6 characters.");
  const id = crypto.randomUUID();
  const sec = newIntakeSecrets(id);
  const expiresAt = new Date(Date.now() + (input.expiryDays ?? settings.expiryDays) * 86_400_000);
  const [inv] = await tx.insert(schema.intakeInvitations).values({
    id, organisationId: a.orgId, formId: v.formId, formVersionId: v.id, recipientName: input.recipientName.trim(), recipientEmail: input.recipientEmail.trim().toLowerCase(),
    tokenHash: sec.tokenHash, tokenNonce: sec.nonce, authMode, passcodeHash: authMode === "PASSCODE" ? await hashPassword(input.passcode!) : null, expiresAt, sentAt: new Date(), createdBy: a.userId,
  }).returning();
  await tx.insert(schema.intakeSubmissions).values({ organisationId: a.orgId, formId: v.formId, formVersionId: v.id, invitationId: id });
  const [u] = await tx.select({ name: schema.users.name, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, a.userId));
  const brand = await getOrgBranding(a.orgId);
  const df = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });
  await queueEmail(tx, {
    orgId: a.orgId, template: "intake_invitation", toEmail: inv!.recipientEmail, intakeInvitationId: id, locale: settings.language, dedupeKey: inviteDedupeKey(id),
    vars: { recipient_name: inv!.recipientName, sender_name: u?.name ?? brand.orgName, form_title: form!.title, expiry_date: df.format(expiresAt), organisation_name: brand.orgName, message: input.message ?? settings.emailTemplate.message ?? "" },
  });
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.form.sent", ctx: a.ctx, metadata: { formId: v.formId, formVersionId: v.id, invitationId: id, recipient: inv!.recipientEmail, authMode, expiresAt: expiresAt.toISOString() } });
  return inv!;
}

async function lockInvitation(tx: Tx, orgId: string, id: string) {
  const [inv] = await tx.select().from(schema.intakeInvitations).where(and(eq(schema.intakeInvitations.id, id), eq(schema.intakeInvitations.organisationId, orgId))).for("update");
  if (!inv) throw notFound("Invitation");
  return inv;
}

export async function revokeInvitation(tx: Tx, a: Actor, id: string) {
  const inv = await lockInvitation(tx, a.orgId, id);
  if (inv.status === "REVOKED") return inv;
  const [sub] = await tx.select({ status: schema.intakeSubmissions.status }).from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, id));
  if (sub?.status === "SUBMITTED") throw new AppError("invalid_state", "This form was already submitted; there is nothing to revoke.");
  const [row] = await tx.update(schema.intakeInvitations).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(schema.intakeInvitations.id, id)).returning();
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.form.revoked", ctx: a.ctx, metadata: { invitationId: id, formId: inv.formId } });
  return row!;
}

/** Support/staff route to obtain the link. Bearer secret: every reveal is audited. */
export async function revealLink(tx: Tx, a: Actor, id: string) {
  const inv = await lockInvitation(tx, a.orgId, id);
  if (inv.status !== "SENT" || inv.expiresAt < new Date()) throw new AppError("invalid_state", "This invitation is no longer active.");
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.link.revealed", ctx: a.ctx, metadata: { invitationId: id } });
  return { url: intakeUrl(deriveIntakeToken(inv.id, inv.tokenNonce)) };
}

/** Explicit amend action: unlocks a submitted form so the organiser can edit and resubmit (creating a new submission revision on resubmit). */
export async function reopenSubmission(tx: Tx, a: Actor, invitationId: string, reason: string) {
  const inv = await lockInvitation(tx, a.orgId, invitationId);
  if (inv.status !== "SENT") throw new AppError("invalid_state", "The invitation is revoked.");
  const [sub] = await tx.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, invitationId)).for("update");
  if (!sub || sub.status !== "SUBMITTED") throw new AppError("invalid_state", "Only a submitted form can be reopened.");
  const expiresAt = inv.expiresAt < new Date() ? new Date(Date.now() + 7 * 86_400_000) : inv.expiresAt; // an amend window even if the original link lapsed
  await tx.update(schema.intakeInvitations).set({ expiresAt }).where(eq(schema.intakeInvitations.id, invitationId));
  await tx.update(schema.intakeSubmissions).set({ status: "REOPENED", lockedAt: null, updatedAt: new Date() }).where(eq(schema.intakeSubmissions.id, sub.id));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.form.reopened", ctx: a.ctx, metadata: { invitationId, submissionId: sub.id, reason: reason.slice(0, 300) } });
  return { submissionId: sub.id };
}

export type InvitationState = "REVOKED" | "EXPIRED" | "SUBMITTED" | "SAVED" | "STARTED" | "VIEWED" | "DELIVERED" | "SENT";
export type ContractStage = "NONE" | "GENERATING" | "GENERATION_FAILED" | "AWAITING_REVIEW" | "READY_TO_SEND" | "READY_FOR_SIGNATURE" | "SIGNED" | "COMPLETED";

/** Every state shown to staff is derived from stored facts (spec §66: no state without backend evidence). */
export function invitationState(inv: Pick<InvitationRow, "status" | "expiresAt" | "openCount" | "startedAt" | "lastSavedAt">, sub: { status: string } | null, emailStatus: string | null, now = new Date()): InvitationState {
  if (inv.status === "REVOKED") return "REVOKED";
  if (sub?.status === "SUBMITTED") return "SUBMITTED";
  if (inv.expiresAt < now) return "EXPIRED";
  if (inv.lastSavedAt) return "SAVED";
  if (inv.startedAt) return "STARTED";
  if (inv.openCount > 0) return "VIEWED";
  if (emailStatus === "DELIVERED") return "DELIVERED";
  return "SENT";
}

export async function contractStage(orgId: string, sub: { generationStatus: string; contractId: string | null; status: string }): Promise<ContractStage> {
  if (sub.status !== "SUBMITTED" && sub.status !== "REOPENED") return "NONE";
  if (["QUEUED", "RUNNING"].includes(sub.generationStatus)) return "GENERATING";
  if (sub.generationStatus === "FAILED") return "GENERATION_FAILED";
  if (!sub.contractId) return "NONE";
  const [c] = await db.select({ status: schema.contracts.status, metadata: schema.contracts.metadata }).from(schema.contracts).where(and(eq(schema.contracts.id, sub.contractId), eq(schema.contracts.organisationId, orgId)));
  if (!c) return "NONE";
  if (c.status === "COMPLETED") return "COMPLETED";
  if (["PARTIALLY_SIGNED", "AWAITING_SIGNATURE"].includes(c.status)) return "SIGNED";
  if (["SENT", "DELIVERED", "VIEWED"].includes(c.status)) return "READY_FOR_SIGNATURE";
  const wf = (c.metadata as { intakeWorkflow?: string })?.intakeWorkflow;
  return wf === "C" ? "READY_TO_SEND" : "AWAITING_REVIEW";
}

export async function listInvitations(orgId: string, opts: { formId?: string; limit?: number; offset?: number } = {}) {
  const rows = await db.select({ inv: schema.intakeInvitations, sub: schema.intakeSubmissions, form: { title: schema.intakeForms.title } }).from(schema.intakeInvitations)
    .innerJoin(schema.intakeSubmissions, eq(schema.intakeSubmissions.invitationId, schema.intakeInvitations.id))
    .innerJoin(schema.intakeForms, eq(schema.intakeForms.id, schema.intakeInvitations.formId))
    .where(and(eq(schema.intakeInvitations.organisationId, orgId), opts.formId ? eq(schema.intakeInvitations.formId, opts.formId) : undefined))
    .orderBy(desc(schema.intakeInvitations.createdAt)).limit(Math.min(opts.limit ?? 50, 200)).offset(opts.offset ?? 0);
  const keys = rows.map((r) => inviteDedupeKey(r.inv.id));
  const emails = keys.length ? await db.select({ key: schema.emailMessages.dedupeKey, status: schema.emailMessages.status }).from(schema.emailMessages).where(and(eq(schema.emailMessages.organisationId, orgId), inArray(schema.emailMessages.dedupeKey, keys))) : [];
  const emailBy = new Map(emails.map((e) => [e.key, e.status]));
  return Promise.all(rows.map(async (r) => ({
    id: r.inv.id, formId: r.inv.formId, formTitle: r.form.title, recipientName: r.inv.recipientName, recipientEmail: r.inv.recipientEmail,
    state: invitationState(r.inv, r.sub, emailBy.get(inviteDedupeKey(r.inv.id)) ?? null),
    emailStatus: emailBy.get(inviteDedupeKey(r.inv.id)) ?? null, contractStage: await contractStage(orgId, r.sub), contractId: r.sub.contractId,
    sentAt: r.inv.sentAt, expiresAt: r.inv.expiresAt, openCount: r.inv.openCount, firstOpenedAt: r.inv.firstOpenedAt, lastOpenedAt: r.inv.lastOpenedAt, submittedAt: r.sub.submittedAt,
    generationStatus: r.sub.generationStatus, generationError: r.sub.generationError,
  })));
}

