import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { updateAgreementDraft, validateVersionById } from "@/server/agreements/service";
import { loadVersionsById } from "@/server/clauses/service";
import { listClauseVersions } from "@/server/clauses/service";
import type { SelectionItem } from "@/server/clauses/compose";
import { moneyFlowSummary } from "@/server/policy/money-flow";
import { PolicyConfig, contractRefundDecision } from "@/server/policy/config";

export const GET = authed<{ vid: string }>("templates.view", async ({ auth, params }) => {
  const v = await validateVersionById(auth.organisationId, uuid(params.vid, "Template version"));
  const pinned = await loadVersionsById(auth.organisationId, (v.version.clauseSelection as SelectionItem[]).map((s) => s.versionId));
  const cfg = PolicyConfig.safeParse(v.version.policyConfig);
  const library = await listClauseVersions(auth.organisationId, { language: v.version.language, status: "PUBLISHED" });
  return {
    version: v.version, agreementType: v.agreementType, errors: v.errors, warnings: v.warnings, flags: v.flags, requiredVariables: v.requiredVariables,
    selection: (v.version.clauseSelection as SelectionItem[]).map((s) => ({ ...s, clause: pinned.get(s.versionId) ?? null })),
    library,
    moneyFlow: cfg.success ? moneyFlowSummary(cfg.data.moneyFlow) : [],
    refundDecision: cfg.success ? contractRefundDecision(cfg.data.refund, v.version.jurisdiction) : null,
  };
});

export const PATCH = authed<{ vid: string }>("templates.edit", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ jurisdiction: z.string().max(20).optional(), language: z.enum(["en", "fa"]).optional(), selection: z.unknown().optional(), policyConfig: z.unknown().optional(), variables: z.unknown().optional(), modules: z.array(z.string()).optional() }));
  return tx((t) => updateAgreementDraft(t, actorOf(auth, ctx), uuid(params.vid, "Template version"), b));
});
