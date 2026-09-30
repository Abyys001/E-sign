import { jurisdictionByCode } from "./jurisdictions";
import { evaluateSigningPolicy, type ExecutionRequirements } from "./signing-policy";

export type LegalFlag = {
  code: string;
  severity: "info" | "review" | "formalities";
  message: string;
};

export const REVIEW_RECOMMENDED = "Legal review recommended before signature.";
export const GENERIC_DISCLAIMER = "Template and legal configuration should be reviewed for the applicable jurisdiction and transaction.";

export type FlagInput = {
  jurisdiction: string;
  execution: ExecutionRequirements;
  /** Clause versions selected, with their review status and whether they are custom/free-text. */
  clauses: Array<{ key: string; reviewStatus: string; custom?: boolean; category?: string }>;
  refundVariant?: string | null;
  exclusivity?: { enabled: boolean; scopeKind?: string; durationDays?: number | null } | null;
  customTermination?: boolean;
  customLiabilityCap?: boolean;
  policyConflicts?: string[];
  consumerFacingTerms?: boolean;
};

/** Compute human-review flags. Flags warn; they never block normal use except `formalities`, which stops automatic signing. */
export function computeLegalFlags(i: FlagInput): LegalFlag[] {
  const out: LegalFlag[] = [];
  const add = (code: string, severity: LegalFlag["severity"], message: string) => out.push({ code, severity, message });
  const profile = jurisdictionByCode(i.jurisdiction);

  if (!profile) add("jurisdiction.unknown", "review", `Unrecognised jurisdiction. ${REVIEW_RECOMMENDED}`);
  else if (!profile.hasVariants) add("jurisdiction.no_variants", "review", `No drafting variants exist for ${profile.label}; generic clauses are used. ${REVIEW_RECOMMENDED}`);
  if (profile?.code === "OTHER") add("jurisdiction.non_standard", "review", `Non-standard jurisdiction. ${REVIEW_RECOMMENDED}`);

  const unreviewed = i.clauses.filter((c) => c.reviewStatus !== "approved");
  if (unreviewed.length) add("clauses.unreviewed", "review", `${unreviewed.length} selected clause(s) have not been approved by legal review. ${REVIEW_RECOMMENDED}`);
  if (i.clauses.some((c) => c.custom)) add("clauses.custom", "review", `Custom clause text is used. ${REVIEW_RECOMMENDED}`);

  if (i.refundVariant === "D") add("refund.custom", "review", `Custom refund terms. ${REVIEW_RECOMMENDED}`);
  if (i.customLiabilityCap) add("liability.custom", "review", `Custom limitation of liability. ${REVIEW_RECOMMENDED}`);
  if (i.customTermination) add("termination.custom", "review", `Unusual termination terms. ${REVIEW_RECOMMENDED}`);
  if (i.exclusivity?.enabled && (i.exclusivity.scopeKind === "all_events" || (i.exclusivity.durationDays ?? 0) > 730)) add("exclusivity.unusual", "review", `Broad or long exclusivity. ${REVIEW_RECOMMENDED}`);
  if (i.consumerFacingTerms) add("consumer.terms", "review", `Consumer-facing terms are affected by these selections. ${REVIEW_RECOMMENDED}`);
  for (const c of i.policyConflicts ?? []) add("policy.conflict", "review", `Conflicting policy rules: ${c}. ${REVIEW_RECOMMENDED}`);

  if (i.execution.witness) add("execution.witness", "review", `Witness requirement. ${REVIEW_RECOMMENDED}`);
  if (i.execution.deed) add("execution.deed", "review", `Deed-like execution. ${REVIEW_RECOMMENDED}`);
  if (i.execution.level !== "SES") add("execution.level", "review", `Advanced/qualified signature requirement. ${REVIEW_RECOMMENDED}`);

  const sign = evaluateSigningPolicy(i.execution, i.jurisdiction);
  if (!sign.autoSignAllowed) add("execution.formalities", "formalities", `${sign.flag} Not supported by this platform: ${sign.unsupported.join(", ")}.`);
  return out;
}

export const requiresLegalReview = (flags: LegalFlag[]) => flags.some((f) => f.severity !== "info");
export const blocksAutoSign = (flags: LegalFlag[]) => flags.some((f) => f.severity === "formalities");
