import { companyVariables } from "../accounting/invoices";
import { and, desc, eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { AppError, notFound } from "../errors";
import { requiredVariables, type ClauseVersionRow, type SelectionItem } from "../clauses/compose";
import { loadVersionsById } from "../clauses/service";
import { PolicyConfig, deriveVariables } from "../policy/config";
import { mergeDefs, type VariableDef } from "../variables/registry";
import { agreementType } from "../agreements/types";
import { moneyFlowSummary } from "../policy/money-flow";
import { jurisdictionByCode } from "../legal/jurisdictions";
import { computeLegalFlags } from "../legal/review-flags";
import { policyExecution } from "../policy/config";
import { FormSchema, FormSettings, WORKFLOWS, WORKFLOW_LABEL, allFields, type FieldDef, type Workflow } from "./schema";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
type FormVersionRow = typeof schema.intakeFormVersions.$inferSelect;

/** Variables the platform fills itself, so the organiser is never asked for them. */
export const AUTO_VARIABLES = new Set(["organisation_name", "support_email", "effective_date", "agreement_title"]);

const FIELD_FOR: Record<string, FieldDef["type"]> = { text: "text", longtext: "long_text", email: "email", phone: "phone", number: "number", currency: "currency", percent: "number", date: "date", time: "time", boolean: "checkbox", select: "dropdown", country: "country" };
const GROUP_TITLE: Record<string, string> = { parties: "Organisation information", event: "Event information", ticketing: "Ticketing", financial: "Financial terms", refunds: "Refund policy", legal: "Legal", contract: "Contract", custom: "Additional information" };

export type Coverage = { needed: string[]; fromForm: string[]; fixed: string[]; derived: string[]; auto: string[]; missing: string[] };

/** Which contract variables the selected clauses need and where each will come from. `missing` blocks publishing. */
export async function computeCoverage(orgId: string, templateVersionId: string, schemaJson: FormSchema | null, settings: FormSettings, dbOrTx: Pick<typeof db, "select"> = db) {
  const [tv] = await dbOrTx.select().from(schema.agreementTemplateVersions).where(and(eq(schema.agreementTemplateVersions.id, templateVersionId), eq(schema.agreementTemplateVersions.organisationId, orgId)));
  if (!tv) throw notFound("Template version");
  const selection = tv.clauseSelection as SelectionItem[];
  const versions = await loadVersionsById(orgId, selection.map((s) => s.versionId), dbOrTx);
  const cfg = PolicyConfig.parse(tv.policyConfig);
  const derivedMap = deriveVariables(cfg, tv.jurisdiction);
  const derived = new Set(Object.keys(derivedMap).filter((k) => !(tv.jurisdiction === "OTHER" && (k === "governing_law" || k === "jurisdiction"))));
  const needed = requiredVariables(selection, versions, derivedMap).filter((k) => !derived.has(k));
  const mapped = new Set<string>();
  if (schemaJson) for (const f of allFields(schemaJson)) { if (f.variable) mapped.add(f.variable); for (const v of Object.values(f.variableMap ?? {})) mapped.add(v); }
  const fixed = new Set(Object.keys(settings.fixedValues));
  const company = new Set(Object.keys(await companyVariables(orgId, dbOrTx)));
  const out: Coverage = { needed, fromForm: [], fixed: [], derived: [...derived], auto: [], missing: [] };
  for (const k of needed) (AUTO_VARIABLES.has(k) || company.has(k) ? out.auto : fixed.has(k) ? out.fixed : mapped.has(k) ? out.fromForm : out.missing).push(k);
  return { coverage: out, templateVersion: tv, versions, defs: mergeDefs((tv.variables as VariableDef[]) ?? []) };
}

/** Starting point for the builder: one section per variable group, one field per variable the organiser must supply. */
export function buildDefaultSchema(missing: string[], defs: VariableDef[]): FormSchema {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const groups = new Map<string, FieldDef[]>();
  for (const k of missing) {
    const d = byKey.get(k) ?? { key: k, label: k.replace(/_/g, " "), type: "text" as const, group: "custom" };
    const list = groups.get(d.group) ?? [];
    list.push({ key: k, type: FIELD_FOR[d.type] ?? "text", label: d.label, required: true, variable: k, ...(d.type === "select" ? { options: (d.options ?? []).map((o) => ({ value: o, label: o })) } : {}) });
    groups.set(d.group, list);
  }
  const order = ["parties", "event", "ticketing", "financial", "refunds", "legal", "contract", "custom"];
  const sections = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([g, fields]) => ({ key: g, title: GROUP_TITLE[g] ?? g, fields }));
  return FormSchema.parse({ sections: sections.length ? sections : [{ key: "info", title: "Information", fields: [{ key: "notes", type: "long_text", label: "Notes", required: false }] }] });
}

export async function createIntakeForm(tx: Tx, a: Actor, input: { title: string; agreementTemplateVersionId: string; workflow?: Workflow; settings?: unknown }) {
  const settings = FormSettings.parse(input.settings ?? {});
  const cov = await computeCoverage(a.orgId, input.agreementTemplateVersionId, null, settings, tx);
  if (!cov.templateVersion.published) throw new AppError("validation_failed", "Choose a published agreement template version.");
  const schemaJson = buildDefaultSchema(cov.coverage.missing, cov.defs);
  const [form] = await tx.insert(schema.intakeForms).values({ organisationId: a.orgId, title: input.title.trim(), createdBy: a.userId }).returning();
  const [ver] = await tx.insert(schema.intakeFormVersions).values({
    formId: form!.id, organisationId: a.orgId, version: 1, agreementTemplateVersionId: input.agreementTemplateVersionId,
    schema: schemaJson, workflow: input.workflow ?? "B", settings, createdBy: a.userId,
  }).returning();
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.form.created", ctx: a.ctx, metadata: { formId: form!.id, versionId: ver!.id, agreementTemplateVersionId: input.agreementTemplateVersionId } });
  return { form: form!, version: ver! };
}

async function lockDraft(tx: Tx, orgId: string, versionId: string) {
  const [v] = await tx.select().from(schema.intakeFormVersions).where(and(eq(schema.intakeFormVersions.id, versionId), eq(schema.intakeFormVersions.organisationId, orgId))).for("update");
  if (!v) throw notFound("Form version");
  if (v.published) throw new AppError("invalid_state", "A published form version cannot be changed. Create a new version.");
  return v;
}

export async function updateIntakeDraft(tx: Tx, a: Actor, versionId: string, patch: { schema?: unknown; settings?: unknown; workflow?: string; agreementTemplateVersionId?: string; title?: string }) {
  const v = await lockDraft(tx, a.orgId, versionId);
  const workflow = patch.workflow ?? v.workflow;
  if (!WORKFLOWS.includes(workflow as Workflow)) throw new AppError("validation_failed", "Unknown workflow.");
  const [row] = await tx.update(schema.intakeFormVersions).set({
    schema: patch.schema === undefined ? v.schema : FormSchema.parse(patch.schema),
    settings: patch.settings === undefined ? v.settings : FormSettings.parse(patch.settings),
    workflow, agreementTemplateVersionId: patch.agreementTemplateVersionId ?? v.agreementTemplateVersionId,
  }).where(eq(schema.intakeFormVersions.id, versionId)).returning();
  if (patch.title) await tx.update(schema.intakeForms).set({ title: patch.title.trim(), updatedAt: new Date() }).where(eq(schema.intakeForms.id, v.formId));
  else await tx.update(schema.intakeForms).set({ updatedAt: new Date() }).where(eq(schema.intakeForms.id, v.formId));
  return row!;
}

export type FormValidation = { errors: string[]; warnings: string[]; coverage: Coverage };

export async function validateFormVersion(orgId: string, versionId: string): Promise<FormValidation & { version: FormVersionRow }> {
  const [v] = await db.select().from(schema.intakeFormVersions).where(and(eq(schema.intakeFormVersions.id, versionId), eq(schema.intakeFormVersions.organisationId, orgId)));
  if (!v) throw notFound("Form version");
  const errors: string[] = [], warnings: string[] = [];
  const s = FormSchema.safeParse(v.schema), st = FormSettings.safeParse(v.settings);
  if (!s.success) errors.push(`Form is invalid: ${s.error.issues[0]?.path.join(".")} ${s.error.issues[0]?.message}`);
  if (!st.success) errors.push(`Settings are invalid: ${st.error.issues[0]?.path.join(".")} ${st.error.issues[0]?.message}`);
  if (!v.agreementTemplateVersionId) errors.push("No agreement template version selected.");
  if (!s.success || !st.success || !v.agreementTemplateVersionId) return { errors, warnings, coverage: { needed: [], fromForm: [], fixed: [], derived: [], auto: [], missing: [] }, version: v };
  const cov = await computeCoverage(orgId, v.agreementTemplateVersionId, s.data, st.data);
  if (!cov.templateVersion.published) errors.push("The agreement template version is not published.");
  for (const k of cov.coverage.missing) errors.push(`Contract variable "${k}" is needed by the selected clauses but no form field maps to it and it has no fixed value.`);
  const fieldVars = new Set(cov.coverage.needed);
  for (const f of allFields(s.data)) for (const k of [f.variable, ...Object.values(f.variableMap ?? {})]) if (k && !fieldVars.has(k) && !AUTO_VARIABLES.has(k)) warnings.push(`Field "${f.label}" maps to "${k}", which no selected clause uses.`);
  if (v.workflow === "A") {
    if (!st.data.signers.bilit) errors.push("Workflow A sends for signature automatically: configure the Bilit signer (name and email).");
    const mapped = new Set(allFields(s.data).flatMap((f) => [f.variable, ...Object.values(f.variableMap ?? {})]));
    for (const k of [st.data.signers.organiser.nameVariable, st.data.signers.organiser.emailVariable]) if (!mapped.has(k) && !(k in st.data.fixedValues)) errors.push(`Workflow A needs the organiser signer: no field maps to "${k}".`);
  }
  if (v.workflow === "A") {
    const tv = cov.templateVersion;
    const flags = computeLegalFlags({ jurisdiction: tv.jurisdiction, execution: policyExecution(PolicyConfig.parse(tv.policyConfig)), clauses: [] });
    if (flags.some((f) => f.severity === "formalities")) warnings.push("This template needs execution formalities the platform cannot perform. Submissions will stop for manual handling instead of being sent for signature.");
  }
  return { errors, warnings, coverage: cov.coverage, version: v };
}

export async function publishFormVersion(tx: Tx, a: Actor, versionId: string) {
  const v = await lockDraft(tx, a.orgId, versionId);
  const res = await validateFormVersion(a.orgId, versionId);
  if (res.errors.length) throw new AppError("validation_failed", "This form cannot be published yet.", { errors: res.errors });
  const [row] = await tx.update(schema.intakeFormVersions).set({ published: true, publishedAt: new Date() }).where(eq(schema.intakeFormVersions.id, versionId)).returning();
  await tx.update(schema.intakeForms).set({ status: "PUBLISHED", updatedAt: new Date() }).where(eq(schema.intakeForms.id, v.formId));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.form.published", ctx: a.ctx, metadata: { formId: v.formId, versionId, version: v.version, workflow: v.workflow } });
  return { version: row!, warnings: res.warnings };
}

export async function createFormDraftFromPublished(tx: Tx, a: Actor, formId: string) {
  const [f] = await tx.select().from(schema.intakeForms).where(and(eq(schema.intakeForms.id, formId), eq(schema.intakeForms.organisationId, a.orgId))).for("update");
  if (!f) throw notFound("Form");
  const [latest] = await tx.select().from(schema.intakeFormVersions).where(eq(schema.intakeFormVersions.formId, formId)).orderBy(desc(schema.intakeFormVersions.version)).limit(1);
  if (!latest) throw notFound("Form version");
  if (!latest.published) return latest;
  const [row] = await tx.insert(schema.intakeFormVersions).values({ formId, organisationId: a.orgId, version: latest.version + 1, agreementTemplateVersionId: latest.agreementTemplateVersionId, schema: latest.schema, workflow: latest.workflow, settings: latest.settings, createdBy: a.userId }).returning();
  return row!;
}

/** Spec §61: everything staff must know before publishing — what is generated, from what, under which rules, sent to whom, what happens next. */
export async function describeFormVersion(orgId: string, versionId: string, recipient?: { name: string; email: string }) {
  const val = await validateFormVersion(orgId, versionId);
  const v = val.version;
  const [tv] = await db.select({ v: schema.agreementTemplateVersions, t: schema.agreementTemplates }).from(schema.agreementTemplateVersions)
    .innerJoin(schema.agreementTemplates, eq(schema.agreementTemplates.id, schema.agreementTemplateVersions.templateId)).where(eq(schema.agreementTemplateVersions.id, v.agreementTemplateVersionId!));
  if (!tv) throw notFound("Template version");
  const versions = await loadVersionsById(orgId, (tv.v.clauseSelection as SelectionItem[]).map((s) => s.versionId));
  const cfg = PolicyConfig.parse(tv.v.policyConfig);
  const settings = FormSettings.parse(v.settings);
  const flags = computeLegalFlags({ jurisdiction: tv.v.jurisdiction, execution: policyExecution(cfg), clauses: [...versions.values()].map((c: ClauseVersionRow) => ({ key: c.clauseKey, reviewStatus: c.reviewStatus })), refundVariant: cfg.refund.variant, exclusivity: { enabled: cfg.exclusivity.enabled, scopeKind: cfg.exclusivity.scopeKind } });
  return {
    generates: agreementType(tv.t.agreementType)?.name ?? tv.t.name,
    template: { id: tv.t.id, name: tv.t.name, version: tv.v.version, versionId: tv.v.id },
    clauses: (tv.v.clauseSelection as SelectionItem[]).map((s) => { const c = versions.get(s.versionId); return { key: s.clauseKey, title: c?.title ?? s.clauseKey, version: c?.version ?? 0, reviewStatus: c?.reviewStatus ?? "unreviewed", category: c?.category ?? "" }; }),
    jurisdiction: { code: tv.v.jurisdiction, label: jurisdictionByCode(tv.v.jurisdiction)?.label ?? tv.v.jurisdiction, warnings: jurisdictionByCode(tv.v.jurisdiction)?.warnings ?? [] },
    businessRules: { refundVariant: cfg.refund.variant, exclusivity: cfg.exclusivity.enabled ? cfg.exclusivity.mode : "none", moneyFlow: moneyFlowSummary(cfg.moneyFlow) },
    flags,
    coverage: val.coverage,
    formVersion: { id: v.id, version: v.version },
    recipient: recipient ?? null,
    workflow: { code: v.workflow as Workflow, label: WORKFLOW_LABEL[v.workflow as Workflow] },
    signers: v.workflow === "A" ? { order: settings.signers.order, bilit: settings.signers.bilit ?? null, organiserFrom: [settings.signers.organiser.nameVariable, settings.signers.organiser.emailVariable] } : null,
    validation: { errors: val.errors, warnings: val.warnings },
  };
}

export async function listIntakeForms(orgId: string) {
  return db.select().from(schema.intakeForms).where(eq(schema.intakeForms.organisationId, orgId)).orderBy(desc(schema.intakeForms.updatedAt));
}
