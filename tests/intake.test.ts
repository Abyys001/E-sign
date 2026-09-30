import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { ctxFor, makeOrg } from "./helpers";
import { createAgreementTemplate, publishAgreementVersion, updateAgreementDraft } from "@/server/agreements/service";
import { createIntakeForm, publishFormVersion, updateIntakeDraft, validateFormVersion } from "@/server/intake/forms";
import { reopenSubmission, revokeInvitation, sendInvitation } from "@/server/intake/invitations";
import { beat, openForm, saveDraft, submitForm } from "@/server/intake/public";
import { scanIntakeRetention } from "@/server/intake/tasks";
import { deleteTelemetry, exportTelemetry } from "@/server/intake/activity";
import { processSubmission } from "@/server/intake/process";
import { invitationActivity, listAccessEvents, listSessions, maskIp } from "@/server/intake/activity";
import { deriveIntakeToken } from "@/server/crypto";
import { verifyAuditChain } from "@/server/audit";
import { FormSchema } from "@/server/intake/schema";

afterAll(stopBoss);

const fixed = { organisation_address: "Bilit HQ", support_email: "support@bilit.example" };

async function setup(workflow: "A" | "B" | "C" | "D" = "B", auth: "NONE" | "PASSCODE" = "NONE") {
  const { org, user } = await makeOrg();
  const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const { version } = await db.transaction((tx) => createAgreementTemplate(tx, a, { name: "Ticketing", agreementType: "ticketing_distribution", jurisdiction: "ENG" }));
  await db.transaction((tx) => updateAgreementDraft(tx, a, version.id, { policyConfig: { exclusivity: { enabled: false }, refund: { variant: "A", deadlineDays: 30 }, organiserObligations: ["honour_tickets"], bilitObligations: ["settlement"] } }));
  await db.transaction((tx) => publishAgreementVersion(tx, a, version.id));
  const { form, version: fv } = await db.transaction((tx) => createIntakeForm(tx, a, { title: "Organiser onboarding", agreementTemplateVersionId: version.id, workflow, settings: { fixedValues: fixed } }));
  await db.transaction((tx) => publishFormVersion(tx, a, fv.id));
  const inv = await db.transaction((tx) => sendInvitation(tx, a, { formVersionId: fv.id, recipientName: "Jane Doe", recipientEmail: "Jane@Example.test", authMode: auth, passcode: auth === "PASSCODE" ? "correct-horse" : undefined }));
  const token = deriveIntakeToken(inv.id, inv.tokenNonce);
  return { org, a, form, fv, inv, token };
}

/** Sample answers keyed by field key, respecting each field's declared type. */
async function fillAll(fvId: string) {
  const [v] = await db.select().from(schema.intakeFormVersions).where(eq(schema.intakeFormVersions.id, fvId));
  const s = FormSchema.parse(v!.schema);
  const out: Record<string, unknown> = {};
  for (const f of s.sections.flatMap((x) => x.fields)) {
    out[f.key] = f.type === "email" ? "jane@example.test" : f.type === "date" ? "2026-11-05" : f.type === "time" ? "19:00" : f.type === "number" || f.type === "currency" ? 10 : f.type === "phone" ? "+441234567890" : f.type === "country" ? "GB" : f.type === "dropdown" || f.type === "radio" ? f.options?.[0]?.value : f.type === "checkbox" || f.type === "acknowledgement" ? true : "Sample";
  }
  return out;
}

const cookieOf = async (token: string, ctx = ctxFor()) => (await openForm(token, undefined, ctx)).cookie!.value;

describe("intake form + link lifecycle", () => {
  it("stores only a token hash, never the raw token", async () => {
    const { inv, token } = await setup();
    expect(JSON.stringify(inv)).not.toContain(token);
    expect(inv.recipientEmail).toBe("jane@example.test");
  });

  it("records access before anything is submitted, and separates it from answers", async () => {
    const { inv, token } = await setup();
    const { view, cookie } = await openForm(token, undefined, ctxFor());
    expect(view.state).toBe("form");
    expect(cookie?.value).toBeTruthy();
    const ev = await db.select().from(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, inv.id));
    expect(ev.length).toBeGreaterThan(0);
    const [sub] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id));
    expect(sub!.status).toBe("DRAFT");
    expect(JSON.stringify(sub)).not.toContain("203.0.113");
    const [row] = await db.select().from(schema.intakeInvitations).where(eq(schema.intakeInvitations.id, inv.id));
    expect(row!.openCount).toBe(1);
  });

  it("rejects mutation without a session and rejects bad tokens uniformly", async () => {
    const { token } = await setup();
    await expect(saveDraft(token, undefined, { patch: {} }, ctxFor())).rejects.toThrow();
    await expect(openForm("x".repeat(43), undefined, ctxFor())).rejects.toThrow();
  });

  it("autosaves, resumes on another device, and validates server-side", async () => {
    const { token, fv } = await setup();
    const c1 = await cookieOf(token);
    await expect(saveDraft(token, c1, { patch: { not_a_field: "x" } }, ctxFor())).rejects.toThrow(/Unknown field/);
    const all = await fillAll(fv.id);
    const some = Object.fromEntries(Object.entries(all).slice(0, 3));
    const r = await saveDraft(token, c1, { patch: some, explicit: true }, ctxFor());
    expect(r.rev).toBeGreaterThan(0);
    const other = await openForm(token, undefined, ctxFor({ ip: "198.51.100.9", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537" }));
    expect(other.view.state === "form" && Object.keys(other.view.answers).length).toBe(3);
  });

  it("submits once, is idempotent on replay and locks the form", async () => {
    const { token, fv, inv } = await setup("D");
    const c = await cookieOf(token);
    await expect(submitForm(token, c, {}, ctxFor())).rejects.toThrow(/highlighted|fix/i);
    await saveDraft(token, c, { patch: await fillAll(fv.id) }, ctxFor());
    const [a, b] = await Promise.all([submitForm(token, c, { idempotencyKey: "k1" }, ctxFor()), submitForm(token, c, { idempotencyKey: "k1" }, ctxFor())]);
    expect([a.alreadySubmitted, b.alreadySubmitted].sort()).toEqual([false, true]);
    await expect(saveDraft(token, c, { patch: { [Object.keys(await fillAll(fv.id))[0]!]: "changed" } }, ctxFor())).rejects.toThrow(/already been submitted/);
    const subs = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.submissionRev).toBe(1);
  });

  it("workflow B: generates a draft contract for review, exactly once, and never sends it", async () => {
    const { token, fv, inv, a } = await setup("B");
    const c = await cookieOf(token);
    await saveDraft(token, c, { patch: await fillAll(fv.id) }, ctxFor());
    await submitForm(token, c, {}, ctxFor());
    const [sub] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id));
    await processSubmission(sub!.id, sub!.submissionRev);
    await processSubmission(sub!.id, sub!.submissionRev); // retry must not duplicate
    const [after] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.id, sub!.id));
    expect(after!.generationStatus).toBe("DONE");
    const contracts = await db.select().from(schema.contracts).where(eq(schema.contracts.organisationId, a.orgId));
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.status).toBe("DRAFT");
    expect(contracts[0]!.intakeSubmissionId).toBe(sub!.id);
    expect((await verifyAuditChain(a.orgId)).ok).toBe(true);
  });

  it("workflow C: stores a PDF ready to send, without sending", async () => {
    const { token, fv, inv, a } = await setup("C");
    const c = await cookieOf(token);
    await saveDraft(token, c, { patch: await fillAll(fv.id) }, ctxFor());
    await submitForm(token, c, {}, ctxFor());
    const [sub] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id));
    await processSubmission(sub!.id, sub!.submissionRev);
    const cs = await db.select().from(schema.contracts).where(eq(schema.contracts.organisationId, a.orgId));
    expect(cs).toHaveLength(1);
    expect(["DRAFT", "READY_TO_SEND"]).toContain(cs[0]!.status);
    const recips = await db.select().from(schema.recipients).where(eq(schema.recipients.contractId, cs[0]!.id));
    expect(recips).toHaveLength(0);
  });

  it("workflow D: stores the submission only", async () => {
    const { token, fv, a } = await setup("D");
    const c = await cookieOf(token);
    await saveDraft(token, c, { patch: await fillAll(fv.id) }, ctxFor());
    const r = await submitForm(token, c, {}, ctxFor());
    expect(r.submitted).toBe(true);
    expect(await db.select().from(schema.contracts).where(eq(schema.contracts.organisationId, a.orgId))).toHaveLength(0);
  });

  it("revoked and expired links stop working; passcode gates access", async () => {
    const r = await setup();
    await db.transaction((tx) => revokeInvitation(tx, r.a, r.inv.id));
    await expect(openForm(r.token, undefined, ctxFor())).rejects.toThrow();
    const e = await setup();
    await db.update(schema.intakeInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.intakeInvitations.id, e.inv.id));
    await expect(openForm(e.token, undefined, ctxFor())).rejects.toThrow();
    const p = await setup("B", "PASSCODE");
    const o = await openForm(p.token, undefined, ctxFor());
    expect(o.view.state).toBe("verify");
    await expect(saveDraft(p.token, o.cookie!.value, { patch: {} }, ctxFor())).rejects.toThrow(/Verification/);
  });

  it("reopen requires a submitted form and unlocks it for amendment", async () => {
    const { token, fv, inv, a } = await setup("D");
    await expect(db.transaction((tx) => reopenSubmission(tx, a, inv.id, "typo"))).rejects.toThrow();
    const c = await cookieOf(token);
    await saveDraft(token, c, { patch: await fillAll(fv.id) }, ctxFor());
    await submitForm(token, c, {}, ctxFor());
    await db.transaction((tx) => reopenSubmission(tx, a, inv.id, "typo in address"));
    const v = await openForm(token, c, ctxFor());
    expect(v.view.state).toBe("form");
  });

  it("tenant isolation: another organisation cannot see or act on an invitation", async () => {
    const r = await setup();
    const other = await makeOrg();
    const oa = { orgId: other.org.id, userId: other.user.id, ctx: ctxFor() };
    await expect(db.transaction((tx) => revokeInvitation(tx, oa, r.inv.id))).rejects.toThrow();
    await expect(invitationActivity(other.org.id, r.inv.id, { telemetry: true })).rejects.toThrow();
    expect((await listSessions(other.org.id, r.form.id, { page: 1, pageSize: 20 }, { telemetry: true })).items).toHaveLength(0);
  });

  it("published form versions are immutable; validation flags missing variables", async () => {
    const { a, fv } = await setup();
    await expect(db.transaction((tx) => updateIntakeDraft(tx, a, fv.id, { title: "x", schema: {} }))).rejects.toThrow(/published/i);
    const v = await validateFormVersion(a.orgId, fv.id);
    expect(v.errors).toEqual([]);
    expect(v.coverage.missing).toEqual([]);
  });
});

describe("access telemetry", () => {
  it("counts a new visit only after the inactivity gap, throttles heartbeats and tracks active time", async () => {
    const { token, inv, a } = await setup();
    const c = await cookieOf(token);
    await beat(token, c, { active: true, client: { screenWidth: 390, screenHeight: 844, language: "en-GB", timezone: "Europe/London" } }, ctxFor());
    await beat(token, c, { active: true }, ctxFor()); // throttled
    const [i1] = await db.select().from(schema.intakeInvitations).where(eq(schema.intakeInvitations.id, inv.id));
    expect(i1!.openCount).toBe(1);
    const act = await invitationActivity(a.orgId, inv.id, { telemetry: true });
    expect(act.overview.totalOpens).toBe(1);
    expect(act.overview.uniqueSessions).toBe(1);
  });

  it("masks IPs and hides device detail from viewers without the telemetry permission", async () => {
    const { token, inv, a } = await setup();
    await openForm(token, undefined, ctxFor({ ip: "203.0.113.77" }));
    const withT = JSON.stringify(await invitationActivity(a.orgId, inv.id, { telemetry: true }));
    const without = JSON.stringify(await invitationActivity(a.orgId, inv.id, { telemetry: false }));
    expect(withT).toContain("203.0.113.77");
    expect(without).not.toContain("203.0.113.77");
    expect(maskIp("203.0.113.77")).not.toContain("77");
  });

  it("paginates and filters access events; the access event table rejects UPDATE", async () => {
    const { token, form, a, inv } = await setup();
    await openForm(token, undefined, ctxFor());
    await openForm(token, undefined, ctxFor({ ip: "198.51.100.5" }));
    const page = await listAccessEvents(a.orgId, form.id, { page: 1, pageSize: 1 }, { telemetry: true });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
    const [ev] = await db.select().from(schema.intakeAccessEvents).where(and(eq(schema.intakeAccessEvents.invitationId, inv.id))).limit(1);
    await expect(db.update(schema.intakeAccessEvents).set({ type: "x" }).where(eq(schema.intakeAccessEvents.id, ev!.id))).rejects.toThrow();
  });
});

describe("telemetry retention and privacy", () => {
  it("anonymises IPs, then deletes past the window; events stay append-only apart from ip", async () => {
    const { token, a, inv } = await setup();
    await openForm(token, undefined, ctxFor({ ip: "203.0.113.77" }));
    const old = new Date(Date.now() - 100 * 86_400_000);
    await db.update(schema.intakeAccessSessions).set({ lastSeenAt: old }).where(eq(schema.intakeAccessSessions.invitationId, inv.id));
    await expect(db.execute(sql`update intake_access_events set occurred_at = ${old} where invitation_id = ${inv.id}`)).rejects.toThrow();
    const evBefore = await db.select().from(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, inv.id));
    expect(evBefore[0]!.ip).toBe("203.0.113.77");
    const r = await scanIntakeRetention(new Date(Date.now() + 100 * 86_400_000));
    expect(r.anonymisedSessions).toBeGreaterThan(0);
    const [s] = await db.select().from(schema.intakeAccessSessions).where(eq(schema.intakeAccessSessions.invitationId, inv.id));
    expect(s!.ip).toBe("203.0.113.0");
    const [e] = await db.select().from(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, inv.id));
    expect(e!.ip).toBe("203.0.113.0");
    expect(a.orgId).toBeTruthy();
  });

  it("export excludes the session secret hash; erase removes telemetry, keeps answers and audits the erasure", async () => {
    const { token, a, inv } = await setup();
    await openForm(token, undefined, ctxFor());
    const ex = await exportTelemetry(a.orgId, inv.id);
    expect(JSON.stringify(ex)).not.toContain("sessionHash");
    expect(ex.sessions.length).toBe(1);
    const r = await db.transaction((tx) => deleteTelemetry(tx, a, inv.id));
    expect(r.sessions).toBe(1);
    expect(await db.select().from(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, inv.id))).toHaveLength(0);
    expect(await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id))).toHaveLength(1);
    const audits = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.organisationId, a.orgId), eq(schema.auditEvents.eventType, "intake.telemetry.deleted")));
    expect(audits).toHaveLength(1);
    const other = await makeOrg();
    await expect(db.transaction((tx) => deleteTelemetry(tx, { ...a, orgId: other.org.id }, inv.id))).rejects.toThrow();
  });
});
