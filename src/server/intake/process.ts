import { and, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { audit, type RequestContext } from "../audit";
import { AppError, notFound } from "../errors";
import { addRecipient, lockContract, saveFields, sendContract } from "../contracts/service";
import { generateContract, GenerationError } from "../generation/service";
import { log } from "../logger";
import { QUEUES, enqueue } from "../jobs";
import { queueEmail } from "../messaging/email";
import { contractStakeholders, notifyUsers } from "../notifications";
import { getOrgBranding } from "../settings";
import { blocksAutoSign, type LegalFlag } from "../legal/review-flags";
import { FormSchema, FormSettings, answersToVariables, type Answers } from "./schema";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
const appUrl = (p: string) => `${env().APP_URL.replace(/\/$/, "")}${p}`;

/**
 * Background job: turn a locked submission into the contract the form's workflow prescribes.
 * Idempotent on (submission, revision): generation is keyed, and a stale/duplicate job exits without effects.
 */
export async function processSubmission(submissionId: string, submissionRev: number) {
  const [sub] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.id, submissionId));
  if (!sub || sub.submissionRev !== submissionRev || sub.status !== "SUBMITTED") return { skipped: "stale" as const };
  if (sub.generationStatus === "DONE" || sub.generationStatus === "HALTED") return { skipped: "done" as const };
  const [inv] = await db.select().from(schema.intakeInvitations).where(eq(schema.intakeInvitations.id, sub.invitationId));
  const [ver] = await db.select().from(schema.intakeFormVersions).where(eq(schema.intakeFormVersions.id, sub.formVersionId));
  const [form] = await db.select({ title: schema.intakeForms.title }).from(schema.intakeForms).where(eq(schema.intakeForms.id, sub.formId));
  if (!inv || !ver || !ver.agreementTemplateVersionId) return { skipped: "missing" as const };
  const settings = FormSettings.parse(ver.settings);
  const formSchema = FormSchema.parse(ver.schema);
  const a: Actor = { orgId: sub.organisationId, userId: inv.createdBy!, ctx: { correlationId: `intake:${sub.id}:${submissionRev}` } };
  await db.update(schema.intakeSubmissions).set({ generationStatus: "RUNNING", generationError: null }).where(eq(schema.intakeSubmissions.id, sub.id));

  const values = { ...settings.fixedValues, ...answersToVariables(formSchema, sub.answers as Answers) };
  try {
    const out = await db.transaction(async (tx) => {
      const gen = await generateContract(tx, a, {
        templateVersionId: ver.agreementTemplateVersionId!, values, contractName: `${form!.title} – ${String(values.organiser_company ?? inv.recipientName)}`,
        source: { type: "intake", submissionId: sub.id, submissionRev, formId: sub.formId, formVersionId: sub.formVersionId },
      });
      await tx.update(schema.contracts).set({ metadata: sql`${schema.contracts.metadata} || ${JSON.stringify({ intakeWorkflow: ver.workflow, generatedFromIntake: { formId: sub.formId, submissionId: sub.id, invitationId: inv.id, formVersion: ver.version } })}::jsonb` }).where(eq(schema.contracts.id, gen.contractId));
      let status: "DONE" | "HALTED" = "DONE";
      let sent = false;
      if (gen.alreadyGenerated) {
        const [c] = await tx.select({ status: schema.contracts.status }).from(schema.contracts).where(eq(schema.contracts.id, gen.contractId));
        sent = !["DRAFT", "READY_TO_SEND"].includes(c!.status);
      }
      if (ver.workflow === "A" && !sent) {
        if (!gen.autoSignAllowed) {
          status = "HALTED"; // formalities the platform cannot perform: stop, never fake it
          await audit(tx, { organisationId: a.orgId, contractId: gen.contractId, userId: a.userId, eventType: "contract.auto_sign_halted", ctx: a.ctx, metadata: { flags: gen.flags.filter((f) => f.severity === "formalities").map((f) => f.message) } });
        } else {
          await autoSend(tx, a, gen.contractId, gen.anchors, settings, values, submissionRev, sub.id);
          sent = true;
        }
      }
      await tx.update(schema.intakeSubmissions).set({ contractId: gen.contractId, generationStatus: status, generationError: status === "HALTED" ? "Additional execution formalities required." : null, updatedAt: new Date() }).where(eq(schema.intakeSubmissions.id, sub.id));
      await notifyAfter(tx, a, { workflow: ver.workflow, contractId: gen.contractId, formTitle: form!.title, halted: status === "HALTED", flags: gen.flags, settings, submissionId: sub.id, rev: submissionRev, sent });
      return { contractId: gen.contractId, status };
    });
    return out;
  } catch (e) {
    if (e instanceof GenerationError || (e instanceof AppError && ["validation_failed", "invalid_state", "config_missing"].includes(e.code))) {
      // Deterministic failure: retrying cannot help. Record it visibly and tell staff; they fix inputs and retry explicitly.
      const message = e instanceof GenerationError ? e.problems.map((p) => p.message).join("; ") : e.message;
      await db.transaction(async (tx) => {
        await tx.update(schema.intakeSubmissions).set({ generationStatus: "FAILED", generationError: message.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.intakeSubmissions.id, sub.id));
        await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.generation_failed", ctx: a.ctx, metadata: { submissionId: sub.id, rev: submissionRev, error: message.slice(0, 500) } });
        await notifyUsers(tx, a.orgId, await contractStakeholders(tx, a.orgId, a.userId), "intake.generation_failed", null, { formId: sub.formId, invitationId: inv.id, formTitle: form!.title, error: message.slice(0, 300) });
      });
      return { failed: message };
    }
    log.error("intake.process_failed", { submissionId, err: e });
    throw e; // transient: let pg-boss retry
  }
}

async function autoSend(tx: Tx, a: Actor, contractId: string, anchors: Array<{ party: "bilit" | "organiser"; kind: "signature" | "date"; page: number; x: number; y: number; width: number; height: number }>, settings: FormSettings, values: Record<string, unknown>, rev: number, submissionId: string) {
  const bilit = settings.signers.bilit;
  if (!bilit) throw new AppError("validation_failed", "The Bilit signer is not configured on this form.");
  const oName = String(values[settings.signers.organiser.nameVariable] ?? ""), oEmail = String(values[settings.signers.organiser.emailVariable] ?? "");
  if (!oName || !oEmail) throw new AppError("validation_failed", "The organiser signer's name or email is missing from the submission.");
  const first = settings.signers.order === "organiser_first" ? "organiser" : "bilit";
  await tx.update(schema.contracts).set({ signingOrder: "SEQUENTIAL" }).where(eq(schema.contracts.id, contractId));
  const org = await addRecipient(tx, a, contractId, { name: oName, email: oEmail, company: values.organiser_company ? String(values.organiser_company) : null, role: "SIGNER", signingOrder: first === "organiser" ? 1 : 2, authLevel: "EMAIL_OTP" });
  const bil = await addRecipient(tx, a, contractId, { name: bilit.name, email: bilit.email, role: "SIGNER", signingOrder: first === "organiser" ? 2 : 1, authLevel: "EMAIL_OTP" });
  const rid = { organiser: org.id, bilit: bil.id };
  await saveFields(tx, a, contractId, anchors.map((an, i) => ({
    id: `${an.party}_${an.kind}_${i}`, recipientId: rid[an.party], type: an.kind, required: true, label: `${an.party === "bilit" ? "Bilit" : "Organiser"} ${an.kind}`,
    rect: { page: an.page, x: an.x, y: an.y, width: an.width, height: an.height },
  })));
  await sendContract(tx, a, contractId, { expiresAt: new Date(Date.now() + settings.signingExpiryDays * 86_400_000), idempotencyKey: `intake:${submissionId}:${rev}` });
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, eventType: "contract.auto_sent_from_intake", ctx: a.ctx, metadata: { submissionId, rev } });
}

async function notifyAfter(tx: Tx, a: Actor, i: { workflow: string; contractId: string; formTitle: string; halted: boolean; flags: LegalFlag[]; settings: FormSettings; submissionId: string; rev: number; sent: boolean }) {
  const [c] = await tx.select({ name: schema.contracts.name, reference: schema.contracts.reference }).from(schema.contracts).where(eq(schema.contracts.id, i.contractId));
  const users = await contractStakeholders(tx, a.orgId, a.userId);
  const review = i.workflow === "B" || i.workflow === "C" || i.halted;
  if (review) {
    await notifyUsers(tx, a.orgId, users, "contract.ready_for_review", i.contractId, { contractName: c!.name, workflow: i.workflow, halted: i.halted, flags: i.flags.map((f) => f.message) });
    const brand = await getOrgBranding(a.orgId);
    for (const to of i.settings.notifyEmails) {
      await queueEmail(tx, { orgId: a.orgId, template: "contract_ready_for_review", toEmail: to, contractId: i.contractId, locale: "en", dedupeKey: `ready_for_review:${i.submissionId}:${i.rev}:${to}`, vars: { recipient_name: "team", contract_name: c!.name, contract_reference: c!.reference, organisation_name: brand.orgName, review_url: appUrl(`/contracts/${i.contractId}`) } });
    }
  }
}

/** Staff action after Option B/C generation: approve for signature (creates the signing workflow), with re-check of formalities. */
export async function approveForSignature(tx: Tx, a: Actor, contractId: string, input: { organiser: { name: string; email: string }; bilit: { name: string; email: string }; order?: "organiser_first" | "bilit_first"; expiryDays?: number }) {
  const c = await lockContract(tx, a.orgId, contractId);
  const manifest = c.generationManifest as { anchors?: Array<{ party: "bilit" | "organiser"; kind: "signature" | "date"; page: number; x: number; y: number; width: number; height: number }> } | null;
  const flags = (c.legalFlags as LegalFlag[]) ?? [];
  if (!manifest?.anchors) throw new AppError("invalid_state", "This contract was not generated from a template, so signing fields must be placed manually.");
  if (blocksAutoSign(flags)) throw new AppError("invalid_state", "Additional execution formalities required: this contract cannot be sent through automatic e-signature.", { flags });
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, eventType: "contract.reviewed", ctx: a.ctx, metadata: { flags: flags.map((f) => f.code) } });
  const settings = FormSettings.parse({ signers: { organiser: {}, bilit: input.bilit, order: input.order ?? "organiser_first" }, signingExpiryDays: input.expiryDays ?? 30 });
  await autoSend(tx, a, contractId, manifest.anchors, settings, { organiser_name: input.organiser.name, organiser_email: input.organiser.email }, c.rev, c.intakeSubmissionId ?? contractId);
  await audit(tx, { organisationId: a.orgId, contractId, userId: a.userId, eventType: "contract.approved_for_signature", ctx: a.ctx, metadata: {} });
  return { contractId };
}

/** Staff action after a failed generation, once the input problem has been fixed (reopen + fix, or template repair). */
export async function retryGeneration(tx: Tx, a: Actor, submissionId: string) {
  const [sub] = await tx.select().from(schema.intakeSubmissions).where(and(eq(schema.intakeSubmissions.id, submissionId), eq(schema.intakeSubmissions.organisationId, a.orgId))).for("update");
  if (!sub) throw notFound("Submission");
  if (sub.generationStatus !== "FAILED" && sub.generationStatus !== "RUNNING") throw new AppError("invalid_state", "Only a failed generation can be retried.");
  await tx.update(schema.intakeSubmissions).set({ generationStatus: "QUEUED", generationError: null }).where(eq(schema.intakeSubmissions.id, sub.id));
  await enqueue(tx, QUEUES.intakeProcess, { submissionId: sub.id, submissionRev: sub.submissionRev }, { singletonKey: `${sub.id}:${sub.submissionRev}:retry:${Date.now()}` });
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.generation_retried", ctx: a.ctx, metadata: { submissionId } });
}
