import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { ctxFor, makeOrg, pngDataUrl } from "./helpers";
import { createAgreementTemplate, publishAgreementVersion, updateAgreementDraft } from "@/server/agreements/service";
import { createIntakeForm, publishFormVersion } from "@/server/intake/forms";
import { sendInvitation } from "@/server/intake/invitations";
import { openForm, saveDraft, submitForm } from "@/server/intake/public";
import { approveForSignature, processSubmission } from "@/server/intake/process";
import { deliverEmail } from "@/server/messaging/email";
import { bindSession, loadByToken, markViewed, requestOtp, submitSigning, verifyOtp } from "@/server/signing/service";
import { finalizeContract } from "@/server/signing/finalize";
import { verifyAuditChain } from "@/server/audit";
import { storage } from "@/server/storage";
import { sha256Bytes } from "@/server/kit/pdf/hash";
import { FormSchema } from "@/server/intake/schema";

afterAll(stopBoss);

// `localhost` may resolve to ::1, where Docker's port proxy for mailpit drops SMTP connections; pin IPv4 for this suite.
process.env.SMTP_HOST = "127.0.0.1";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const uniq = () => Math.random().toString(36).slice(2, 9);

/** Send every queued message for the org through the real SMTP transport (the worker does this in production). */
async function deliverAll(orgId: string) {
  const rows = await db.select().from(schema.emailMessages).where(and(eq(schema.emailMessages.organisationId, orgId), eq(schema.emailMessages.status, "QUEUED")));
  for (const m of rows) await deliverEmail(m.id, 0, 3);
  return rows.length;
}
async function mailTo(to: string, subjectPart: string): Promise<{ text: string; html: string; subject: string }> {
  for (let i = 0; i < 20; i++) {
    const s = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages?: Array<{ ID: string; Subject: string }> };
    const hit = s.messages?.find((m) => m.Subject.includes(subjectPart));
    if (hit) { const d = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { Text: string; HTML: string }; return { text: d.Text, html: d.HTML, subject: hit.Subject }; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail to ${to} with subject containing "${subjectPart}" reached mailpit (${MAILPIT})`);
}

async function scenario(workflow: "A" | "B" | "C", jurisdiction = "ENG", exec: Record<string, unknown> = {}) {
  const { org, user } = await makeOrg();
  const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const tag = uniq();
  const organiserEmail = `organiser-${tag}@example.test`, bilitEmail = `bilit-${tag}@example.test`;
  const { version } = await db.transaction((tx) => createAgreementTemplate(tx, a, { name: "Ticketing", agreementType: "ticketing_distribution", jurisdiction }));
  await db.transaction((tx) => updateAgreementDraft(tx, a, version.id, { policyConfig: { exclusivity: { enabled: false }, refund: { variant: "A", deadlineDays: 30 }, organiserObligations: ["honour_tickets"], bilitObligations: ["settlement"], execution: exec } }));
  await db.transaction((tx) => publishAgreementVersion(tx, a, version.id));
  const settings = { fixedValues: { organisation_address: "Bilit HQ", support_email: "support@bilit.example" }, signers: { organiser: {}, bilit: { name: "Bilit Signatory", email: bilitEmail }, order: "organiser_first" } };
  const { form, version: fv } = await db.transaction((tx) => createIntakeForm(tx, a, { title: "Organiser onboarding", agreementTemplateVersionId: version.id, workflow, settings }));
  await db.transaction((tx) => publishFormVersion(tx, a, fv.id));
  const inv = await db.transaction((tx) => sendInvitation(tx, a, { formVersionId: fv.id, recipientName: "Jane Organiser", recipientEmail: organiserEmail, authMode: "NONE" }));
  expect(await deliverAll(org.id)).toBeGreaterThan(0);
  // The organiser only ever has the emailed link.
  const invite = await mailTo(organiserEmail, "Organiser onboarding");
  const token = /\/intake\/([A-Za-z0-9_-]{20,})/.exec(invite.text + invite.html)?.[1];
  expect(token, "invitation email must contain the secure link").toBeTruthy();
  const view = await openForm(token!, undefined, ctxFor({ ip: "198.51.100.20" }));
  expect(view.view.state).toBe("form");
  const cookie = view.cookie!.value;
  const [v] = await db.select().from(schema.intakeFormVersions).where(eq(schema.intakeFormVersions.id, fv.id));
  const answers: Record<string, unknown> = {};
  for (const f of FormSchema.parse(v!.schema).sections.flatMap((s) => s.fields)) {
    answers[f.key] = f.key === "organiser_email" ? organiserEmail : f.type === "email" ? "ops@example.test" : f.type === "date" ? "2026-11-05" : f.type === "time" ? "19:00" : f.type === "number" || f.type === "currency" ? 10 : f.type === "phone" ? "+441234567890" : f.type === "country" ? "GB" : "Sample";
  }
  await saveDraft(token!, cookie, { patch: answers, explicit: true }, ctxFor());
  await submitForm(token!, cookie, { idempotencyKey: `k-${tag}` }, ctxFor());
  const [sub] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id));
  await processSubmission(sub!.id, sub!.submissionRev);
  const [after] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.id, sub!.id));
  return { org, a, sub: after!, organiserEmail, bilitEmail, tag };
}

async function signAs(email: string, name: string, orgId: string) {
  await deliverAll(orgId);
  const m = await mailTo(email, "sign");
  const token = /\/s\/([A-Za-z0-9_-]{20,})/.exec(m.text + m.html)?.[1];
  expect(token, `signing email to ${email} must carry a link`).toBeTruthy();
  const ctx = ctxFor();
  const l0 = await loadByToken(token!, ctx);
  const s = await bindSession(l0, undefined, ctx);
  await markViewed(l0, ctx);
  const l = await loadByToken(token!, ctx); // reload: the session is now bound on the request row
  await requestOtp(l, s.sessionValue, ctx);
  await deliverAll(orgId);
  const otpMail = await mailTo(email, "verification code");
  const code = /\b(\d{6})\b/.exec(otpMail.subject + otpMail.text)?.[1];
  expect(code, "OTP email must carry the code").toBeTruthy();
  await verifyOtp(l, s.sessionValue, code!, ctx);
  const fields = await db.select().from(schema.recipientFields).where(and(eq(schema.recipientFields.contractId, l.contract.id), eq(schema.recipientFields.recipientId, l.recipient.id)));
  const input: Record<string, unknown> = {};
  for (const f of fields) input[f.key] = f.type === "signature" ? { signature: { method: "TYPED", typedText: name, imageDataUrl: pngDataUrl() } } : { value: { kind: "text", text: new Date().toISOString().slice(0, 10) } };
  return submitSigning(token!, s.sessionValue, { consent: true, locale: "en", fields: input as never }, ctx);
}

describe("end to end: intake → generated contract → signature → certificate", () => {
  it("Option A: submit → contract auto-sent → both sign → final PDF, certificate, valid audit chain", async () => {
    const r = await scenario("A");
    expect(r.sub.generationStatus).toBe("DONE");
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, r.sub.contractId!));
    expect(c!.status).toBe("SENT");
    const first = await signAs(r.organiserEmail, "Jane Organiser", r.org.id);
    expect(first.contractComplete).toBe(false);
    const second = await signAs(r.bilitEmail, "Bilit Signatory", r.org.id);
    expect(second.contractComplete).toBe(true);
    expect((await finalizeContract(c!.id)).status).toBe("completed");
    const [done] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, c!.id));
    expect(done!.status).toBe("COMPLETED");
    const [fin] = await db.select().from(schema.contractVersions).where(and(eq(schema.contractVersions.contractId, c!.id), eq(schema.contractVersions.kind, "FINAL")));
    const [obj] = await db.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, fin!.storageObjectId));
    expect(sha256Bytes(await storage().getBuffer(obj!.key))).toBe(fin!.sha256);
    const [cert] = await db.select().from(schema.completionCertificates).where(eq(schema.completionCertificates.contractId, c!.id));
    expect(cert!.finalDocumentHash).toBe(fin!.sha256);
    expect((await verifyAuditChain(c!.id)).ok).toBe(true);
    expect((await verifyAuditChain(r.org.id)).ok).toBe(true);
    const types = (await db.select({ t: schema.auditEvents.eventType }).from(schema.auditEvents).where(eq(schema.auditEvents.organisationId, r.org.id))).map((x) => x.t);
    for (const t of ["intake.form.sent", "intake.link.accessed", "intake.form.saved", "intake.form.submitted", "contract.generated_from_intake", "contract.auto_sent_from_intake"]) expect(types, t).toContain(t);
  }, 60_000);

  it("Option B: draft for review, never sent; staff approve → signing request is sent", async () => {
    const r = await scenario("B");
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, r.sub.contractId!));
    expect(c!.status).toBe("DRAFT");
    expect(await db.select().from(schema.recipients).where(eq(schema.recipients.contractId, c!.id))).toHaveLength(0);
    await db.transaction((tx) => approveForSignature(tx, r.a, c!.id, { organiser: { name: "Jane Organiser", email: r.organiserEmail }, bilit: { name: "Bilit Signatory", email: r.bilitEmail } }));
    const [sent] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, c!.id));
    expect(sent!.status).toBe("SENT");
    await deliverAll(r.org.id);
    await mailTo(r.organiserEmail, "sign");
  }, 60_000);

  it("Option C: PDF stored ready to send; nothing emailed to signers", async () => {
    const r = await scenario("C");
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, r.sub.contractId!));
    expect(["DRAFT", "READY_TO_SEND"]).toContain(c!.status);
    const [ver] = await db.select().from(schema.contractVersions).where(eq(schema.contractVersions.contractId, c!.id));
    expect(ver).toBeTruthy();
    expect((await db.select().from(schema.emailMessages).where(and(eq(schema.emailMessages.contractId, c!.id), eq(schema.emailMessages.template, "signature_requested"))))).toHaveLength(0);
  }, 60_000);

  it("Option A halts when the jurisdiction/policy needs formalities the platform cannot perform", async () => {
    const r = await scenario("A", "ENG", { witness: true });
    expect(r.sub.generationStatus).toBe("HALTED");
    expect(r.sub.generationError).toBe("Additional execution formalities required.");
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, r.sub.contractId!));
    expect(c!.status).toBe("DRAFT");
    expect(await db.select().from(schema.recipients).where(eq(schema.recipients.contractId, c!.id))).toHaveLength(0);
    await expect(db.transaction((tx) => approveForSignature(tx, r.a, c!.id, { organiser: { name: "J", email: r.organiserEmail }, bilit: { name: "B", email: r.bilitEmail } }))).rejects.toThrow(/formalities/i);
  }, 60_000);
});
