import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { ctxFor, expectPg, makeOrg } from "./helpers";
import { createAgreementTemplate, createDraftFromPublished, publishAgreementVersion, updateAgreementDraft, validateVersionById } from "@/server/agreements/service";
import { createClauseDraft, publishClauseVersion, seedClauseLibrary } from "@/server/clauses/service";
import { generateContract, GenerationError } from "@/server/generation/service";
import { loadVersionBytes } from "@/server/documents";
import { sha256 } from "@/server/crypto";
import { verifyAuditChain } from "@/server/audit";

afterAll(stopBoss);

const values = {
  organiser_name: "Jane Doe", organiser_title: "Director", organiser_company: "Example Events Ltd", organiser_registration_number: "12345678", organiser_address: "1 High Street, London",
  organiser_email: "jane@example.test", organiser_phone: "+441234567890", organisation_address: "Bilit HQ", support_email: "support@bilit.example",
  event_name: "Spring Gala", event_date: "2026-11-05", event_time: "19:00", event_venue: "Grand Hall", event_city: "London", event_country: "United Kingdom", event_type: "Concert", event_capacity: "1200",
  ticket_inventory: "1000", ticket_price: "45", currency: "GBP", booking_fee: "3.50", refund_deadline: "2026-12-01",
};

async function publishedTemplate(over: Record<string, unknown> = {}, jurisdiction = "ENG") {
  const { org, user } = await makeOrg();
  const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const { version } = await db.transaction((tx) => createAgreementTemplate(tx, a, { name: "Organizer – Bilit Event Ticketing & Distribution Agreement", agreementType: "ticketing_distribution", jurisdiction }));
  await db.transaction((tx) => updateAgreementDraft(tx, a, version.id, {
    policyConfig: { exclusivity: { enabled: true, events: ["Spring Gala"], breachConsequences: ["notice", "suspension"] }, refund: { variant: "A", deadlineDays: 30 }, organiserObligations: ["honour_tickets", "no_bypass"], bilitObligations: ["ticket_distribution", "settlement"], ...over },
  }));
  const pub = await db.transaction((tx) => publishAgreementVersion(tx, a, version.id));
  return { org, user, a, versionId: version.id, pub };
}

describe("agreement template + generation", () => {
  it("publishes a template pinned to exact clause versions and surfaces legal flags", async () => {
    const { pub } = await publishedTemplate();
    expect(pub.version.published).toBe(true);
    expect(pub.flags.map((f) => f.code)).toContain("clauses.unreviewed");
  });

  it("published template versions and clause versions are immutable at the DB level", async () => {
    const { versionId, a } = await publishedTemplate();
    await expectPg(db.update(schema.agreementTemplateVersions).set({ jurisdiction: "DE" }).where(eq(schema.agreementTemplateVersions.id, versionId)), /immutable/);
    await expectPg(db.delete(schema.agreementTemplateVersions).where(eq(schema.agreementTemplateVersions.id, versionId)), /cannot be deleted/);
    await expect(db.transaction((tx) => updateAgreementDraft(tx, a, versionId, { jurisdiction: "DE" }))).rejects.toThrow(/published/i);
    const [cv] = await db.select().from(schema.clauseVersions).where(eq(schema.clauseVersions.organisationId, a.orgId)).limit(1);
    await expectPg(db.update(schema.clauseVersions).set({ body: "changed" }).where(eq(schema.clauseVersions.id, cv!.id)), /immutable/);
  });

  it("generates a hashed PDF contract with a full manifest, traceability and audit events", async () => {
    const { a, versionId } = await publishedTemplate();
    const r = await db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values, source: { type: "manual" } }));
    const bytes = await loadVersionBytes(a.orgId, r.versionId);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha256(bytes)).toBe(r.sha256);
    expect(r.anchors.length).toBe(4);
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, r.contractId));
    const m = c!.generationManifest as { clauses: Array<{ clauseKey: string; versionId: string }>; jurisdiction: string; templateVersionId: string; documentSha256: string; policy: { refund: { variant: string } } };
    expect(m.templateVersionId).toBe(versionId);
    expect(m.jurisdiction).toBe("ENG");
    expect(m.documentSha256).toBe(r.sha256);
    expect(m.policy.refund.variant).toBe("A");
    const keys = m.clauses.map((x) => x.clauseKey);
    expect(keys).toContain("exclusivity.grant");
    expect(keys).toContain("refunds.variant.A");
    expect(keys).not.toContain("refunds.variant.B"); // unselected variants are never included
    expect(keys).not.toContain("exclusivity.non_exclusive");
    expect(keys).not.toContain("financial.reserve"); // reserve not configured => not invented
    expect(keys).not.toContain("execution.witnesses");
    const ev = (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.contractId, r.contractId))).map((e) => e.eventType);
    expect(ev).toEqual(expect.arrayContaining(["contract.jurisdiction.selected", "contract.clauses.selected", "contract.policy.selected", "contract.refund_policy.selected", "contract.exclusivity.selected"]));
    expect((await verifyAuditChain(r.contractId)).ok).toBe(true);
  });

  it("is idempotent per intake submission revision: a retry creates no second contract", async () => {
    const { a, versionId } = await publishedTemplate();
    const source = { type: "intake" as const, submissionId: crypto.randomUUID(), submissionRev: 1, formId: crypto.randomUUID(), formVersionId: crypto.randomUUID() };
    const [x, y] = await Promise.all([
      db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values, source })),
      db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values, source })),
    ]);
    expect(x.contractId).toBe(y.contractId);
    expect([x.alreadyGenerated, y.alreadyGenerated].sort()).toEqual([false, true]);
    const all = await db.select().from(schema.contracts).where(eq(schema.contracts.organisationId, a.orgId));
    expect(all.length).toBe(1);
    const again = await db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values, source: { ...source, submissionRev: 2 } }));
    expect(again.contractId).not.toBe(x.contractId); // an explicit re-submission revision is a new document
  });

  it("refuses to generate with unresolved variables and lists every problem", async () => {
    const { a, versionId } = await publishedTemplate();
    const { event_name: _e, organiser_company: _o, ...partial } = values;
    const err = await db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values: partial, source: { type: "manual" } })).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.problems.map((p: { variable?: string }) => p.variable)).toEqual(expect.arrayContaining(["event_name", "organiser_company"]));
    expect(await db.select().from(schema.contracts).where(eq(schema.contracts.organisationId, a.orgId))).toHaveLength(0);
  });

  it("rejects invalid typed values", async () => {
    const { a, versionId } = await publishedTemplate();
    const err = await db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values: { ...values, organiser_email: "nope", event_date: "05/11/2026" }, source: { type: "manual" } })).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.problems.map((p: { variable?: string }) => p.variable)).toEqual(expect.arrayContaining(["organiser_email", "event_date"]));
  });

  it("policy-derived variables cannot be overridden by intake answers", async () => {
    const { a, versionId } = await publishedTemplate();
    const r = await db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values: { ...values, refund_booking_fee_text: "refunded in full", governing_law: "Atlantis" }, source: { type: "manual" } }));
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, r.contractId));
    const vars = (c!.generationManifest as { variables: Record<string, string> }).variables;
    expect(vars.refund_booking_fee_text).toBe("retained by Bilit");
    expect(vars.governing_law).toBe("the laws of England and Wales");
  });

  it("tenant isolation: another organisation cannot generate from this template", async () => {
    const { versionId } = await publishedTemplate();
    const other = await makeOrg();
    const err = await db.transaction((tx) => generateContract(tx, { orgId: other.org.id, userId: other.user.id, ctx: ctxFor() }, { templateVersionId: versionId, values, source: { type: "manual" } })).catch((e) => e);
    expect(err.code).toBe("not_found");
  });

  it("jurisdiction selects clause variants and warns for jurisdictions without variants", async () => {
    const us = await publishedTemplate({}, "US-NY");
    const v = await validateVersionById(us.org.id, us.versionId);
    const sel = v.version.clauseSelection as Array<{ clauseKey: string; versionId: string }>;
    const dp = (await db.select().from(schema.clauseVersions).where(eq(schema.clauseVersions.id, sel.find((s) => s.clauseKey === "data.protection")!.versionId)))[0]!;
    expect(dp.jurisdiction).toBe("US");
    const de = await publishedTemplate({}, "DE");
    expect(de.pub.flags.map((f) => f.code)).toContain("jurisdiction.no_variants");
  });

  it("witness requirement halts auto-signing and raises 'Additional execution formalities required.'", async () => {
    const { a, versionId } = await publishedTemplate({ execution: { witness: true } });
    const r = await db.transaction((tx) => generateContract(tx, a, { templateVersionId: versionId, values, source: { type: "manual" } }));
    expect(r.autoSignAllowed).toBe(false);
    expect(r.flags.find((f) => f.code === "execution.formalities")!.message).toContain("Additional execution formalities required.");
  });

  it("a published template can be revised only through a new version, leaving the old one intact", async () => {
    const { a, versionId } = await publishedTemplate();
    const [t] = await db.select().from(schema.agreementTemplateVersions).where(eq(schema.agreementTemplateVersions.id, versionId));
    const draft = await db.transaction((tx) => createDraftFromPublished(tx, a, t!.templateId));
    expect(draft.version).toBe(2);
    expect(draft.published).toBe(false);
    const [old] = await db.select().from(schema.agreementTemplateVersions).where(eq(schema.agreementTemplateVersions.id, versionId));
    expect(old!.published).toBe(true);
  });

  it("clause library re-seed is idempotent and custom clauses version instead of overwriting", async () => {
    const { org, user } = await makeOrg();
    const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    const first = await db.transaction((tx) => seedClauseLibrary(tx, a));
    const second = await db.transaction((tx) => seedClauseLibrary(tx, a));
    expect(first.versions).toBeGreaterThan(80);
    expect(second.versions).toBe(0);
    const d = await db.transaction((tx) => createClauseDraft(tx, a, { clauseKey: "general.waiver", body: "Custom waiver text." }));
    expect(d.version).toBe(2);
    expect(d.status).toBe("DRAFT");
    const p = await db.transaction((tx) => publishClauseVersion(tx, a, d.id));
    expect(p.status).toBe("PUBLISHED");
  });
});
