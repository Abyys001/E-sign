import { and, eq, sql } from "drizzle-orm";
import { schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { AppError, notFound } from "../errors";
import { canonicalJson } from "../canonical";
import { sha256 } from "../crypto";
import { addContractVersion } from "../documents";
import { createContract } from "../contracts/service";
import { getOrgBranding } from "../settings";
import { composeClauses, type SelectionItem } from "../clauses/compose";
import { loadVersionsById } from "../clauses/service";
import { companyVariables } from "../accounting/invoices";
import { PolicyConfig, deriveVariables, OPTIONAL_DERIVED, policyExecution } from "../policy/config";
import { computeLegalFlags, blocksAutoSign, type LegalFlag } from "../legal/review-flags";
import { evaluateSigningPolicy } from "../legal/signing-policy";
import { jurisdictionByCode } from "../legal/jurisdictions";
import { agreementType } from "../agreements/types";
import { mergeDefs, validateValue, VariableDef, type VariableValues } from "../variables/registry";
import { renderAgreementPdf, type SignatureAnchor } from "./pdf";

export const ENGINE_VERSION = "1";

type Actor = { orgId: string; userId: string; ctx: RequestContext };

export type GenerateInput = {
  templateVersionId: string;
  /** Answers/variables supplied by the intake form or staff. Policy-derived variables always override these. */
  values: VariableValues;
  source: { type: "intake"; submissionId: string; submissionRev: number; formId: string; formVersionId: string } | { type: "manual" };
  contractName?: string;
};

export type GenerateResult = {
  contractId: string;
  reference: string;
  versionId: string;
  sha256: string;
  anchors: SignatureAnchor[];
  flags: LegalFlag[];
  autoSignAllowed: boolean;
  alreadyGenerated: boolean;
};

/** Thrown with the full list of problems so nothing is silently skipped. */
export class GenerationError extends AppError {
  constructor(message: string, public problems: Array<{ code: string; message: string; variable?: string }>) {
    super("validation_failed", message, { problems });
  }
}

/**
 * Template + pinned clause versions + variables + policy + jurisdiction (+ intake submission) -> immutable draft contract PDF.
 * Idempotent per (submission, rev): a retry returns the existing contract instead of creating another.
 */
export async function generateContract(tx: Tx, a: Actor, input: GenerateInput): Promise<GenerateResult> {
  const generationKey = input.source.type === "intake" ? `${input.source.submissionId}:${input.source.submissionRev}` : null;
  if (generationKey) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`gen:${generationKey}`}, 0))`);
    const [existing] = await tx.select().from(schema.contracts).where(eq(schema.contracts.generationKey, generationKey));
    if (existing) {
      const [ver] = await tx.select().from(schema.contractVersions).where(eq(schema.contractVersions.id, existing.currentVersionId!));
      return { contractId: existing.id, reference: existing.reference, versionId: ver!.id, sha256: ver!.sha256, anchors: ((existing.generationManifest as { anchors?: SignatureAnchor[] } | null)?.anchors) ?? [], flags: (existing.legalFlags as LegalFlag[]) ?? [], autoSignAllowed: !blocksAutoSign((existing.legalFlags as LegalFlag[]) ?? []), alreadyGenerated: true };
    }
  }

  const [row] = await tx.select({ v: schema.agreementTemplateVersions, t: schema.agreementTemplates }).from(schema.agreementTemplateVersions)
    .innerJoin(schema.agreementTemplates, eq(schema.agreementTemplates.id, schema.agreementTemplateVersions.templateId))
    .where(and(eq(schema.agreementTemplateVersions.id, input.templateVersionId), eq(schema.agreementTemplateVersions.organisationId, a.orgId)));
  if (!row) throw notFound("Template version");
  if (!row.v.published) throw new AppError("invalid_state", "Contracts can only be generated from a published template version.");

  const cfg = PolicyConfig.parse(row.v.policyConfig);
  const customDefs = (row.v.variables as VariableDef[]) ?? [];
  const defs = mergeDefs(customDefs);
  const selection = row.v.clauseSelection as SelectionItem[];
  const versions = await loadVersionsById(a.orgId, selection.map((s) => s.versionId), tx);
  const branding = await getOrgBranding(a.orgId);
  const company = await companyVariables(a.orgId, tx);

  const base: VariableValues = {
    organisation_name: branding.orgName, support_email: branding.supportEmail ?? "",
    // Bilit's registered details (Finance settings → Invoices) fill the contract party block; intake answers can still override.
    ...company,
    effective_date: new Date().toISOString().slice(0, 10), agreement_title: input.contractName ?? row.t.name,
    ...input.values,
  };
  // Policy-derived variables are authoritative: an intake answer must not silently override the signed-off policy.
  const values: VariableValues = { ...base, ...deriveVariables(cfg, row.v.jurisdiction, input.values) };

  const problems: GenerationError["problems"] = [];
  for (const d of defs) { const err = validateValue(d, values[d.key]); if (err) problems.push({ code: "invalid_value", variable: d.key, message: `${d.label} ${err}` }); }

  const composed = composeClauses({ selection, versions, values, customDefs, optionalVars: OPTIONAL_DERIVED, keepOrder: !!agreementType(row.t.agreementType)?.ordered });
  for (const [variable, clauseKeys] of Object.entries(composed.unresolved)) problems.push({ code: "unresolved_variable", variable, message: `"${variable}" has no value (needed by ${clauseKeys.join(", ")})` });
  if (!composed.included.length) problems.push({ code: "no_clauses", message: "No clauses remain after applying conditions." });
  if (problems.length) throw new GenerationError(`Contract cannot be generated: ${problems.length} problem(s).`, problems);

  const execution = policyExecution(cfg);
  const flags = computeLegalFlags({
    jurisdiction: row.v.jurisdiction, execution,
    clauses: composed.included.map((c) => ({ key: c.clauseKey, reviewStatus: c.reviewStatus })),
    refundVariant: cfg.refund.variant, exclusivity: { enabled: cfg.exclusivity.enabled, scopeKind: cfg.exclusivity.scopeKind },
    customLiabilityCap: cfg.liability.custom, customTermination: cfg.termination.custom,
    consumerFacingTerms: composed.included.some((c) => c.clauseKey.startsWith("refunds.") || c.clauseKey === "compliance.consumer_law"),
  });
  const signing = evaluateSigningPolicy(execution, row.v.jurisdiction);

  const title = String(values.agreement_title);
  const contract = await createContract(tx, a, { name: input.contractName ?? row.t.name, contractType: agreementType(row.t.agreementType)?.key ?? "general", metadata: { source: input.source.type } });
  const pdf = await renderAgreementPdf({
    title, reference: contract.reference, organisationName: String(values.organisation_name), organiserName: String(values.organiser_company ?? values.organiser_name ?? "Counterparty"),
    effectiveDate: String(values.effective_date), sections: composed.sections,
    footerNote: `Generated from template v${row.v.version} · ${jurisdictionByCode(row.v.jurisdiction)?.label ?? row.v.jurisdiction}`,
  });
  const ver = await addContractVersion(tx, { orgId: a.orgId, contractId: contract.id, userId: a.userId, bytes: pdf.bytes, reason: input.source.type === "intake" ? "Generated from intake form" : "Generated from template", ctx: a.ctx });

  const manifest = {
    engineVersion: ENGINE_VERSION, generatedAt: new Date().toISOString(),
    agreementType: row.t.agreementType, templateId: row.t.id, templateVersionId: row.v.id, templateVersion: row.v.version,
    jurisdiction: row.v.jurisdiction, language: row.v.language,
    clauses: composed.included, excludedClauses: composed.excluded,
    policy: cfg, policyHash: sha256(canonicalJson(cfg)),
    variables: values, inputsHash: sha256(canonicalJson({ values, selection, policy: cfg })),
    source: input.source, documentSha256: ver.sha256, anchors: pdf.anchors,
    signing: { requirements: execution, autoSignAllowed: signing.autoSignAllowed, unsupported: signing.unsupported },
  };
  await tx.update(schema.contracts).set({
    currentVersionId: ver.id, agreementTemplateVersionId: row.v.id, generationKey, generationManifest: manifest, legalFlags: flags,
    intakeSubmissionId: input.source.type === "intake" ? input.source.submissionId : null,
  }).where(eq(schema.contracts.id, contract.id));

  const meta = { templateVersionId: row.v.id, submissionId: input.source.type === "intake" ? input.source.submissionId : null };
  const ev = (eventType: string, metadata: Record<string, unknown>) => audit(tx, { organisationId: a.orgId, contractId: contract.id, userId: a.userId, eventType, ctx: a.ctx, documentHash: ver.sha256, metadata: { ...meta, ...metadata } });
  if (input.source.type === "intake") await ev("contract.generated_from_intake", { formId: input.source.formId, formVersionId: input.source.formVersionId, submissionRev: input.source.submissionRev });
  await ev("contract.jurisdiction.selected", { jurisdiction: row.v.jurisdiction });
  await ev("contract.clauses.selected", { clauses: composed.included.map((c) => ({ key: c.clauseKey, versionId: c.versionId, version: c.version })) });
  await ev("contract.policy.selected", { policyHash: manifest.policyHash, moneyFlow: cfg.moneyFlow.collectsTicketRevenue });
  await ev("contract.refund_policy.selected", { variant: cfg.refund.variant, fundedBy: cfg.refund.fundedBy });
  if (cfg.exclusivity.enabled) await ev("contract.exclusivity.selected", { mode: cfg.exclusivity.mode, scopeKind: cfg.exclusivity.scopeKind });
  if (flags.length) await ev("contract.legal_flags.raised", { flags: flags.map((f) => f.code) });

  return { contractId: contract.id, reference: contract.reference, versionId: ver.id, sha256: ver.sha256, anchors: pdf.anchors, flags, autoSignAllowed: signing.autoSignAllowed && !blocksAutoSign(flags), alreadyGenerated: false };
}

