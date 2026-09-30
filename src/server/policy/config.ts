import { z } from "zod";
import { ExclusivityConfig, exclusivityVariables } from "./exclusivity";
import { MoneyFlowConfig, moneyFlowVariables } from "./money-flow";
import { evaluateRefund, variantRules, RefundRule, REFUND_REASONS, type RefundDecision, type RefundReason, type RefundVariant } from "./refund-engine";
import { DEFAULT_EXECUTION, IDENTITY_METHODS, SIGNATURE_LEVELS, type ExecutionRequirements } from "../legal/signing-policy";
import { jurisdictionByCode } from "../legal/jurisdictions";

/** Catalogues of configurable obligations. Contractual terms only — not statements of law. */
export const ORGANISER_OBLIGATIONS: Record<string, string> = {
  accurate_event_info: "provide accurate and complete Event information and keep it up to date",
  licences: "obtain and maintain all licences and permits needed for the Event",
  accurate_inventory: "provide accurate ticket inventory",
  event_legality: "ensure the Event and its promotion are lawful",
  honour_tickets: "honour every valid ticket sold through Bilit",
  cooperate_support: "cooperate with Bilit's customer support",
  notify_changes: "notify Bilit promptly of any change to the Event",
  notify_cancellation_risk: "notify Bilit immediately of any risk that the Event may be cancelled, postponed or materially changed",
  fund_refunds: "fund or assist refunds where this Agreement so provides",
  no_bypass: "not bypass Bilit for sales of the Covered Inventory",
  no_divert: "not divert sales of the Covered Inventory to another channel",
  event_materials: "provide the event materials Bilit reasonably requires",
};
export const BILIT_OBLIGATIONS: Record<string, string> = {
  ticket_distribution: "distribute tickets for the Event through its platform",
  payment_processing: "arrange payment processing for ticket sales",
  customer_support: "provide first-line customer support to ticket holders",
  reporting: "provide sales reporting to the Organiser",
  settlement: "settle amounts due to the Organiser as provided in this Agreement",
  scanning: "provide ticket scanning infrastructure at the Event",
  refund_processing: "process customer refunds as provided in this Agreement",
  marketing_services: "provide the marketing services described in this Agreement",
  production_services: "provide the production services described in this Agreement",
  venue_sourcing: "provide venue sourcing services",
};

export const RefundConfig = z.object({
  variant: z.enum(["A", "B", "C", "D", "E", "F", "G", "H"]).default("A"),
  deadlineDays: z.number().int().min(0).max(365).default(30),
  fundedBy: z.enum(["organiser", "bilit", "shared"]).default("organiser"),
  /** Extra rules layered on top (e.g. law / consumer-rights overrides supplied by the compliance configuration). */
  overrides: z.array(RefundRule).max(50).default([]),
  customText: z.string().max(4000).optional(),
});
export type RefundConfig = z.infer<typeof RefundConfig>;

export const ExecutionConfig = z.object({
  level: z.enum(SIGNATURE_LEVELS).default("SES"),
  identity: z.enum(IDENTITY_METHODS).default("EMAIL_OTP"),
  witness: z.boolean().default(false),
  physicalPresence: z.boolean().default(false),
  deed: z.boolean().default(false),
  certificateRequired: z.boolean().default(false),
  trustedTimestampRequired: z.boolean().default(false),
  additionalFormalities: z.array(z.string().min(1).max(200)).max(10).default([]),
});

export const PolicyConfig = z.object({
  exclusivity: ExclusivityConfig.default({ enabled: false, mode: "exclusive", scopeKind: "listed_events", events: [], inventoryScope: "all_inventory", inventoryCategories: [], approvedExceptions: [], approvedChannels: [], territory: "Worldwide", breachConsequences: ["notice"], cureDays: 14 }),
  moneyFlow: MoneyFlowConfig.default(MoneyFlowConfig.parse({})),
  refund: RefundConfig.default(RefundConfig.parse({})),
  organiserObligations: z.array(z.string()).default([]),
  bilitObligations: z.array(z.string()).default([]),
  execution: ExecutionConfig.default(ExecutionConfig.parse({})),
  liability: z.object({ custom: z.boolean().default(false), capText: z.string().max(500).default("the fees paid or payable to Bilit under this Agreement in the twelve months before the claim") }).default({ custom: false, capText: "the fees paid or payable to Bilit under this Agreement in the twelve months before the claim" }),
  termination: z.object({ custom: z.boolean().default(false), cureDays: z.number().int().min(1).max(180).default(14) }).default({ custom: false, cureDays: 14 }),
  recordRetentionYears: z.number().int().min(1).max(30).default(7),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

const list = (xs: string[], cat: Record<string, string>) => xs.filter((k) => cat[k]).map((k, i) => `(${String.fromCharCode(97 + i)}) ${cat[k]};`).join("\n");

const TREAT: Record<string, string> = { refund: "refunded", retain: "retained by Bilit", refund_pro_rata: "refunded pro rata", unspecified: "dealt with as the parties agree in writing" };
const FUND: Record<string, string> = { organiser: "the Organiser", bilit: "Bilit", shared: "Bilit and the Organiser in equal shares", customer: "the customer", none: "no party", unspecified: "the party the parties agree in writing" };

/** Refund engine decision for the contract-level reasons the clauses talk about. */
export function contractRefundDecision(cfg: RefundConfig, jurisdiction: string, reason: RefundReason = "organiser_cancellation"): RefundDecision {
  const rules = [...variantRules(cfg.variant as RefundVariant, { deadlineDays: cfg.deadlineDays, fundedBy: cfg.fundedBy }), ...cfg.overrides];
  return evaluateRefund({ reason, jurisdiction, rules });
}

export const policyExecution = (cfg: PolicyConfig): ExecutionRequirements => ({ ...DEFAULT_EXECUTION, ...cfg.execution });

/** Optional derived variables that may legitimately be an empty string. */
export const OPTIONAL_DERIVED = new Set(["booking_fee_terms", "processing_fee_terms", "taxes_note", "settlement_conditions", "exclusivity_liquidated", "refund_custom_text"]);

/**
 * All policy-derived variables. Values the user typed (intake answers) win over derived ones only for non-policy keys:
 * policy variables are always authoritative so a form answer cannot silently override a signed-off policy.
 */
export function deriveVariables(cfg: PolicyConfig, jurisdiction: string, customValues: Record<string, unknown> = {}): Record<string, unknown> {
  const profile = jurisdictionByCode(jurisdiction);
  const dec = contractRefundDecision(cfg.refund, jurisdiction);
  const gov = profile?.code === "OTHER" ? String(customValues.governing_law ?? "") : (profile?.governingLaw ?? "");
  const forum = profile?.code === "OTHER" ? String(customValues.jurisdiction ?? "") : (profile?.forum ?? "");
  return {
    ...exclusivityVariables(cfg.exclusivity),
    ...moneyFlowVariables(cfg.moneyFlow),
    governing_law: gov, jurisdiction: forum,
    refund_variant: cfg.refund.variant,
    refund_window_days: String(cfg.refund.deadlineDays),
    refund_funded_by: FUND[cfg.refund.fundedBy]!,
    refund_booking_fee_text: TREAT[dec.bookingFee]!,
    refund_processing_fee_text: TREAT[dec.processingFee]!,
    refund_chargeback_by: FUND[dec.chargebackFeeBy === "unspecified" ? "unspecified" : dec.chargebackFeeBy]!,
    refund_custom_text: cfg.refund.customText ?? "",
    liability_cap_text: cfg.liability.capText,
    cure_days: String(cfg.termination.cureDays),
    record_retention_years: String(cfg.recordRetentionYears),
    execution_witness: cfg.execution.witness,
    has_organiser_obligations: cfg.organiserObligations.length > 0,
    organiser_obligations_list: list(cfg.organiserObligations, ORGANISER_OBLIGATIONS),
    has_bilit_obligations: cfg.bilitObligations.length > 0,
    bilit_obligations_list: list(cfg.bilitObligations, BILIT_OBLIGATIONS),
    ...Object.fromEntries((["ticketing", "venue", "production", "marketing", "staffing", "artist", "supplier", "event_day"] as const).map((m) => [`module_${m}`, false])),
  };
}

export { REFUND_REASONS };
