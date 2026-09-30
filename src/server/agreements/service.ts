import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { AppError, notFound } from "../errors";
import { ConditionSchema } from "../clauses/condition";
import { pickVariant, requiredVariables, type ClauseVersionRow, type SelectionItem } from "../clauses/compose";
import { listClauseVersions, loadVersionsById, seedClauseLibrary } from "../clauses/service";
import { AGREEMENT_TYPES, agreementType } from "./types";
import { PolicyConfig, deriveVariables, policyExecution } from "../policy/config";
import { computeLegalFlags, type LegalFlag } from "../legal/review-flags";
import { isKnownJurisdiction, jurisdictionByCode } from "../legal/jurisdictions";
import { VariableDef } from "../variables/registry";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
type VersionRow = typeof schema.agreementTemplateVersions.$inferSelect;

export const LANGUAGES = ["en", "fa"] as const;

export const SelectionItemSchema = z.object({ clauseKey: z.string().min(1).max(120), versionId: z.string().uuid(), required: z.boolean().optional(), condition: ConditionSchema.nullish() });
export const SelectionSchema = z.array(SelectionItemSchema).max(300);

const regionOf = (jur: string) => jurisdictionByCode(jur)?.region ?? "OTHER";

/** Pin the best published variant of each clause key for a jurisdiction/language. Keys with no variant are reported, never silently dropped. */
export function pinSelection(keys: Array<{ clauseKey: string; required?: boolean; condition?: SelectionItem["condition"] }>, all: ClauseVersionRow[], jurisdiction: string, language: string) {
  const byKey = new Map<string, ClauseVersionRow[]>();
  for (const c of all) byKey.set(c.clauseKey, [...(byKey.get(c.clauseKey) ?? []), c]);
  const selection: SelectionItem[] = [];
  const missing: string[] = [];
  for (const k of keys) {
    const v = pickVariant(byKey.get(k.clauseKey) ?? [], jurisdiction, regionOf(jurisdiction), language);
    if (!v) { missing.push(k.clauseKey); continue; }
    selection.push({ clauseKey: k.clauseKey, versionId: v.id, required: k.required, condition: k.condition ?? null });
  }
  return { selection, missing };
}

export type VersionValidation = { errors: string[]; warnings: string[]; flags: LegalFlag[]; requiredVariables: string[] };

/** Validate a template version prior to publishing. Errors block publishing; warnings and flags are shown. */
export function validateAgreementVersion(v: Pick<VersionRow, "jurisdiction" | "language" | "clauseSelection" | "policyConfig" | "modules">, agreementTypeKey: string, versions: Map<string, ClauseVersionRow>): VersionValidation {
  const errors: string[] = [], warnings: string[] = [];
  if (!isKnownJurisdiction(v.jurisdiction)) errors.push(`Unknown jurisdiction "${v.jurisdiction}".`);
  if (!LANGUAGES.includes(v.language as (typeof LANGUAGES)[number])) errors.push(`Unsupported language "${v.language}".`);
  const sel = SelectionSchema.safeParse(v.clauseSelection);
  const policy = PolicyConfig.safeParse(v.policyConfig);
  if (!sel.success) errors.push(`Clause selection is invalid: ${sel.error.issues[0]?.message}`);
  if (!policy.success) errors.push(`Policy configuration is invalid: ${policy.error.issues[0]?.path.join(".")} ${policy.error.issues[0]?.message}`);
  if (!sel.success || !policy.success) return { errors, warnings, flags: [], requiredVariables: [] };

  const type = agreementType(agreementTypeKey);
  const chosen = new Set(sel.data.map((s) => s.clauseKey));
  for (const r of type?.clauses.filter((c) => c.required) ?? []) if (!chosen.has(r.clauseKey)) errors.push(`Required clause "${r.clauseKey}" is not selected.`);
  for (const s of sel.data) {
    const cv = versions.get(s.versionId);
    if (!cv) { errors.push(`Clause "${s.clauseKey}": pinned version not found.`); continue; }
    if (cv.clauseKey !== s.clauseKey) errors.push(`Clause "${s.clauseKey}": pinned version belongs to another clause.`);
    if (cv.status !== "PUBLISHED") errors.push(`Clause "${s.clauseKey}": version ${cv.version} is not published.`);
    if (cv.language !== v.language) errors.push(`Clause "${s.clauseKey}": language ${cv.language} does not match ${v.language}.`);
  }
  const cfg = policy.data;
  if (cfg.exclusivity.enabled && !chosen.has("exclusivity.grant") && cfg.exclusivity.mode === "exclusive") warnings.push("Exclusivity is configured but the exclusivity clause is not selected.");
  if (!cfg.exclusivity.enabled && chosen.has("exclusivity.grant")) warnings.push("The exclusivity clause is selected but exclusivity is not enabled; it will be omitted from generated contracts.");
  if (!chosen.has(`refunds.variant.${cfg.refund.variant}`) && [...chosen].some((k) => k.startsWith("refunds."))) warnings.push(`Refund variant ${cfg.refund.variant} is configured but its clause is not selected.`);

  const flags = computeLegalFlags({
    jurisdiction: v.jurisdiction, execution: policyExecution(cfg),
    clauses: sel.data.map((s) => ({ key: s.clauseKey, reviewStatus: versions.get(s.versionId)?.reviewStatus ?? "unreviewed" })),
    refundVariant: cfg.refund.variant, exclusivity: { enabled: cfg.exclusivity.enabled, scopeKind: cfg.exclusivity.scopeKind },
    customLiabilityCap: cfg.liability.custom, customTermination: cfg.termination.custom,
    consumerFacingTerms: [...chosen].some((k) => k.startsWith("refunds.") || k === "compliance.consumer_law"),
    policyConflicts: contractPolicyConflicts(cfg, chosen),
  });
  const values = deriveVariables(cfg, v.jurisdiction);
  return { errors, warnings, flags, requiredVariables: requiredVariables(sel.data, versions, values) };
}

/** Cross-policy contradictions worth a human look. */
function contractPolicyConflicts(cfg: PolicyConfig, chosen: Set<string>): string[] {
  const out: string[] = [];
  if (cfg.refund.variant === "B" && cfg.moneyFlow.bookingFee.enabled && cfg.moneyFlow.refundsCustomers === "organiser") out.push("booking fee is refundable (variant B) but the organiser is the refunding party");
  if (cfg.exclusivity.enabled && cfg.exclusivity.mode === "non_exclusive" && cfg.organiserObligations.some((o) => o === "no_bypass" || o === "no_divert")) out.push("non-exclusive ticketing selected with no-bypass/no-divert obligations");
  if (cfg.exclusivity.enabled && cfg.exclusivity.mode === "exclusive" && chosen.has("exclusivity.non_exclusive")) out.push("exclusive and non-exclusive clauses are both selected");
  return out;
}

export async function createAgreementTemplate(tx: Tx, a: Actor, input: { name: string; agreementType: string; jurisdiction: string; language?: string }) {
  const type = agreementType(input.agreementType);
  if (!type) throw new AppError("validation_failed", "Unknown agreement type.");
  if (!isKnownJurisdiction(input.jurisdiction)) throw new AppError("validation_failed", "Unknown jurisdiction.");
  const language = input.language ?? "en";
  const [any] = await tx.select({ id: schema.clauses.id }).from(schema.clauses).where(eq(schema.clauses.organisationId, a.orgId)).limit(1);
  if (!any) await seedClauseLibrary(tx, a);
  const all = await listClauseVersions(a.orgId, { language, status: "PUBLISHED" }, tx);
  const { selection, missing } = pinSelection(type.clauses, all, input.jurisdiction, language);
  if (missing.length === type.clauses.length) throw new AppError("config_missing", `No published clauses exist for language "${language}".`);
  const [t] = await tx.insert(schema.agreementTemplates).values({ organisationId: a.orgId, name: input.name.trim(), agreementType: type.key, createdBy: a.userId }).returning();
  const [ver] = await tx.insert(schema.agreementTemplateVersions).values({
    templateId: t!.id, organisationId: a.orgId, version: 1, jurisdiction: input.jurisdiction, language, modules: type.modules,
    clauseSelection: selection, policyConfig: PolicyConfig.parse({}), variables: [], createdBy: a.userId,
  }).returning();
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "agreement_template.created", ctx: a.ctx, metadata: { templateId: t!.id, agreementType: type.key, jurisdiction: input.jurisdiction, language, unavailableClauses: missing } });
  return { template: t!, version: ver!, unavailableClauses: missing };
}

async function lockDraft(tx: Tx, orgId: string, versionId: string) {
  const [v] = await tx.select().from(schema.agreementTemplateVersions).where(and(eq(schema.agreementTemplateVersions.id, versionId), eq(schema.agreementTemplateVersions.organisationId, orgId))).for("update");
  if (!v) throw notFound("Template version");
  if (v.published) throw new AppError("invalid_state", "A published template version cannot be changed. Create a new version.");
  return v;
}

export type DraftPatch = { jurisdiction?: string; language?: string; selection?: unknown; policyConfig?: unknown; variables?: unknown; modules?: string[] };

export async function updateAgreementDraft(tx: Tx, a: Actor, versionId: string, patch: DraftPatch) {
  const v = await lockDraft(tx, a.orgId, versionId);
  const jurisdiction = patch.jurisdiction ?? v.jurisdiction;
  const language = patch.language ?? v.language;
  if (!isKnownJurisdiction(jurisdiction)) throw new AppError("validation_failed", "Unknown jurisdiction.");
  let selection = patch.selection === undefined ? (v.clauseSelection as SelectionItem[]) : SelectionSchema.parse(patch.selection);
  if (patch.selection === undefined && (jurisdiction !== v.jurisdiction || language !== v.language)) {
    // Selection intent is kept (clause keys) but re-pinned to the variants for the new jurisdiction/language.
    const all = await listClauseVersions(a.orgId, { language, status: "PUBLISHED" }, tx);
    selection = pinSelection(selection, all, jurisdiction, language).selection;
  }
  const policyConfig = patch.policyConfig === undefined ? v.policyConfig : PolicyConfig.parse(patch.policyConfig);
  const variables = patch.variables === undefined ? v.variables : z.array(VariableDef).max(200).parse(patch.variables);
  const [row] = await tx.update(schema.agreementTemplateVersions).set({ jurisdiction, language, clauseSelection: selection, policyConfig, variables, modules: patch.modules ?? v.modules }).where(eq(schema.agreementTemplateVersions.id, versionId)).returning();
  await tx.update(schema.agreementTemplates).set({ updatedAt: new Date() }).where(eq(schema.agreementTemplates.id, v.templateId));
  return row!;
}

export async function validateVersionById(orgId: string, versionId: string): Promise<VersionValidation & { version: VersionRow; agreementType: string }> {
  const [row] = await db.select({ v: schema.agreementTemplateVersions, t: schema.agreementTemplates }).from(schema.agreementTemplateVersions)
    .innerJoin(schema.agreementTemplates, eq(schema.agreementTemplates.id, schema.agreementTemplateVersions.templateId))
    .where(and(eq(schema.agreementTemplateVersions.id, versionId), eq(schema.agreementTemplateVersions.organisationId, orgId)));
  if (!row) throw notFound("Template version");
  const ids = ((row.v.clauseSelection as SelectionItem[]) ?? []).map((s) => s.versionId);
  const versions = await loadVersionsById(orgId, ids);
  return { ...validateAgreementVersion(row.v, row.t.agreementType, versions), version: row.v, agreementType: row.t.agreementType };
}

/** Publish: freezes clause pins, jurisdiction and policy. After this the version can never change (DB trigger enforces it). */
export async function publishAgreementVersion(tx: Tx, a: Actor, versionId: string) {
  const v = await lockDraft(tx, a.orgId, versionId);
  const res = await validateVersionById(a.orgId, versionId);
  if (res.errors.length) throw new AppError("validation_failed", "This template cannot be published yet.", { errors: res.errors });
  const [row] = await tx.update(schema.agreementTemplateVersions).set({ published: true, publishedAt: new Date() }).where(eq(schema.agreementTemplateVersions.id, versionId)).returning();
  await tx.update(schema.agreementTemplates).set({ status: "PUBLISHED", updatedAt: new Date() }).where(eq(schema.agreementTemplates.id, v.templateId));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "agreement_template.published", ctx: a.ctx, metadata: { templateId: v.templateId, versionId, version: v.version, jurisdiction: v.jurisdiction, flags: res.flags.map((f) => f.code) } });
  return { version: row!, flags: res.flags, warnings: res.warnings };
}

export async function createDraftFromPublished(tx: Tx, a: Actor, templateId: string) {
  const [t] = await tx.select().from(schema.agreementTemplates).where(and(eq(schema.agreementTemplates.id, templateId), eq(schema.agreementTemplates.organisationId, a.orgId))).for("update");
  if (!t) throw notFound("Template");
  const [latest] = await tx.select().from(schema.agreementTemplateVersions).where(eq(schema.agreementTemplateVersions.templateId, templateId)).orderBy(desc(schema.agreementTemplateVersions.version)).limit(1);
  if (!latest) throw notFound("Template version");
  if (!latest.published) return latest; // an editable draft already exists
  const [row] = await tx.insert(schema.agreementTemplateVersions).values({
    templateId, organisationId: a.orgId, version: latest.version + 1, jurisdiction: latest.jurisdiction, language: latest.language, modules: latest.modules,
    clauseSelection: latest.clauseSelection, policyConfig: latest.policyConfig, variables: latest.variables, createdBy: a.userId,
  }).returning();
  return row!;
}

export async function listAgreementTemplates(orgId: string) {
  return db.select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.organisationId, orgId)).orderBy(desc(schema.agreementTemplates.updatedAt));
}

export { AGREEMENT_TYPES };
