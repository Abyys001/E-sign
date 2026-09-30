import { z } from "zod";

/**
 * Refund policy engine. Pure and data-driven: rules are configuration, not code branches per reason.
 * Precedence (highest first): applicable law → mandatory consumer rights → signed contract → customer ticket terms → Bilit default.
 * The engine never labels a treatment "required by law" unless a law-layer rule said so.
 */

export const REFUND_REASONS = [
  "organiser_cancellation", "venue_cancellation", "artist_cancellation", "government_restriction", "force_majeure",
  "postponement", "rescheduling", "event_date_change", "material_event_change", "duplicate_booking", "fraud", "payment_failure", "chargeback",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const LAYERS = ["law", "consumer_rights", "contract", "ticket_terms", "bilit_default"] as const;
export type Layer = (typeof LAYERS)[number];

export const COMPONENTS = ["ticket", "bookingFee", "processingFee", "taxes", "shipping"] as const;
export type Component = (typeof COMPONENTS)[number];

export const FUNDERS = ["organiser", "bilit", "shared", "customer", "none"] as const;
export const RESCHEDULE = ["tickets_valid", "refund_option", "refund_only", "not_applicable"] as const;

const Treatment = z.enum(["refund", "retain", "refund_pro_rata"]);

/** The outcome a rule prescribes. Every field optional: a rule only speaks to what it governs. */
export const Outcome = z.object({
  ticket: Treatment.optional(),
  bookingFee: Treatment.optional(),
  processingFee: Treatment.optional(),
  taxes: Treatment.optional(),
  shipping: Treatment.optional(),
  chargebackFeeBy: z.enum(["organiser", "bilit", "shared", "customer"]).optional(),
  fundedBy: z.enum(FUNDERS).optional(),
  settlementReversal: z.boolean().optional(),
  deadlineDays: z.number().int().min(0).max(3650).optional(),
  partial: z.boolean().optional(),
  reschedule: z.enum(RESCHEDULE).optional(),
});
export type Outcome = z.infer<typeof Outcome>;

export const RefundRule = z.object({
  id: z.string().min(1).max(80),
  layer: z.enum(LAYERS),
  reasons: z.array(z.enum(REFUND_REASONS)).min(1).or(z.literal("*")),
  /** Only applies when the jurisdiction code matches (prefix match, e.g. "US" matches "US-NY"); omitted = all. */
  jurisdictions: z.array(z.string()).optional(),
  /** Free-text provenance shown to staff, e.g. "Bilit default policy". */
  label: z.string().min(1).max(200),
  outcome: Outcome,
});
export type RefundRule = z.infer<typeof RefundRule>;

/** Bilit default operating policy. It is a business policy, not law, and any higher layer overrides it. */
export const BILIT_DEFAULT_LABEL = "Default Bilit Policy: Booking Fee Non-Refundable";
const CANCELLATION_REASONS: RefundReason[] = ["organiser_cancellation", "venue_cancellation", "artist_cancellation", "government_restriction", "force_majeure"];
export const BILIT_DEFAULT_RULES: RefundRule[] = [
  { id: "bilit.default.cancel", layer: "bilit_default", reasons: CANCELLATION_REASONS, label: BILIT_DEFAULT_LABEL,
    outcome: { ticket: "refund", bookingFee: "retain", processingFee: "retain", taxes: "refund", shipping: "refund", fundedBy: "organiser", chargebackFeeBy: "organiser", settlementReversal: true, deadlineDays: 30, partial: false } },
  { id: "bilit.default.postpone", layer: "bilit_default", reasons: ["postponement", "rescheduling", "event_date_change"], label: "Default Bilit Policy: tickets remain valid; refund option per contract",
    outcome: { reschedule: "tickets_valid", ticket: "refund", bookingFee: "retain", processingFee: "retain", taxes: "refund", fundedBy: "organiser", settlementReversal: true, deadlineDays: 30 } },
  { id: "bilit.default.material", layer: "bilit_default", reasons: ["material_event_change"], label: "Default Bilit Policy: refund of ticket amount on material change",
    outcome: { ticket: "refund", bookingFee: "retain", processingFee: "retain", taxes: "refund", fundedBy: "organiser", settlementReversal: true, deadlineDays: 30 } },
  { id: "bilit.default.duplicate", layer: "bilit_default", reasons: ["duplicate_booking"], label: "Default Bilit Policy: duplicate booking fully refunded",
    outcome: { ticket: "refund", bookingFee: "refund", processingFee: "refund", taxes: "refund", fundedBy: "bilit", settlementReversal: true, deadlineDays: 14 } },
  { id: "bilit.default.fraud", layer: "bilit_default", reasons: ["fraud", "payment_failure"], label: "Default Bilit Policy: no refund of retained amounts; payment reversed",
    outcome: { ticket: "refund", bookingFee: "retain", processingFee: "retain", taxes: "refund", fundedBy: "none", settlementReversal: true, chargebackFeeBy: "customer" } },
  { id: "bilit.default.chargeback", layer: "bilit_default", reasons: ["chargeback"], label: "Default Bilit Policy: chargeback reverses settlement",
    outcome: { ticket: "refund", bookingFee: "refund", processingFee: "retain", taxes: "refund", fundedBy: "organiser", settlementReversal: true, chargebackFeeBy: "organiser" } },
];

export type RefundContext = {
  reason: RefundReason;
  jurisdiction: string;
  /** Configured rules (any layer). The Bilit defaults are added automatically unless disableDefaults. */
  rules: RefundRule[];
  disableDefaults?: boolean;
};

export type Provenance = { component: Component | "chargebackFeeBy" | "fundedBy" | "settlementReversal" | "deadlineDays" | "partial" | "reschedule"; layer: Layer; ruleId: string; label: string };
export type RefundDecision = {
  ticket: Treatment_;
  bookingFee: Treatment_;
  processingFee: Treatment_;
  taxes: Treatment_;
  shipping: Treatment_;
  chargebackFeeBy: "organiser" | "bilit" | "shared" | "customer" | "unspecified";
  fundedBy: (typeof FUNDERS)[number] | "unspecified";
  settlementReversal: boolean;
  deadlineDays: number | null;
  partial: boolean;
  reschedule: (typeof RESCHEDULE)[number];
  /** Which rule determined each field; "unspecified" fields had no rule and need a human decision. */
  provenance: Provenance[];
  unspecified: string[];
  /** Layer that decided the booking fee, so UI can say "Default Bilit Policy" vs "Contract" vs "Applicable law". */
  bookingFeeLayer: Layer | null;
  conflicts: string[];
};
type Treatment_ = z.infer<typeof Treatment> | "unspecified";

const matches = (r: RefundRule, ctx: RefundContext) =>
  (r.reasons === "*" || r.reasons.includes(ctx.reason)) &&
  (!r.jurisdictions || r.jurisdictions.some((j) => ctx.jurisdiction === j || ctx.jurisdiction.startsWith(`${j}-`)));

export function evaluateRefund(ctx: RefundContext): RefundDecision {
  const rules = [...ctx.rules, ...(ctx.disableDefaults ? [] : BILIT_DEFAULT_RULES)]
    .filter((r) => matches(r, ctx))
    // Highest-precedence layer first; within a layer later-declared rules win (stable sort keeps declaration order).
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => LAYERS.indexOf(a.r.layer) - LAYERS.indexOf(b.r.layer) || b.idx - a.idx)
    .map((x) => x.r);

  const provenance: Provenance[] = [];
  const conflicts: string[] = [];
  const pick = <K extends keyof Outcome>(k: K): { value: NonNullable<Outcome[K]>; rule: RefundRule } | null => {
    let found: { value: NonNullable<Outcome[K]>; rule: RefundRule } | null = null;
    for (const r of rules) {
      const v = r.outcome[k];
      if (v === undefined) continue;
      if (!found) found = { value: v as NonNullable<Outcome[K]>, rule: r };
      else if (found.rule.layer === r.layer && JSON.stringify(found.value) !== JSON.stringify(v)) conflicts.push(`${k}: "${found.rule.label}" vs "${r.label}" (same layer)`);
    }
    return found;
  };
  const rec = (component: Provenance["component"], p: { rule: RefundRule } | null) => { if (p) provenance.push({ component, layer: p.rule.layer, ruleId: p.rule.id, label: p.rule.label }); };

  const unspecified: string[] = [];
  const treat = (k: Component): Treatment_ => { const p = pick(k); rec(k, p); if (!p) { unspecified.push(k); return "unspecified"; } return p.value; };
  const ticket = treat("ticket"), bookingFee = treat("bookingFee"), processingFee = treat("processingFee"), taxes = treat("taxes"), shipping = treat("shipping");
  const cb = pick("chargebackFeeBy"), fb = pick("fundedBy"), sr = pick("settlementReversal"), dl = pick("deadlineDays"), pa = pick("partial"), rs = pick("reschedule");
  rec("chargebackFeeBy", cb); rec("fundedBy", fb); rec("settlementReversal", sr); rec("deadlineDays", dl); rec("partial", pa); rec("reschedule", rs);
  if (!cb) unspecified.push("chargebackFeeBy");
  if (!fb) unspecified.push("fundedBy");
  const bfRule = provenance.find((p) => p.component === "bookingFee");

  return {
    ticket, bookingFee, processingFee, taxes, shipping,
    chargebackFeeBy: cb?.value ?? "unspecified", fundedBy: fb?.value ?? "unspecified",
    settlementReversal: sr?.value ?? false, deadlineDays: dl?.value ?? null, partial: pa?.value ?? false, reschedule: rs?.value ?? "not_applicable",
    provenance, unspecified, bookingFeeLayer: bfRule?.layer ?? null, conflicts,
  };
}

/** Rules a clause variant A–H expands to (contract layer). Variant D is fully custom and supplied by the user. */
export type RefundVariant = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
export const REFUND_VARIANTS: Record<RefundVariant, { name: string; summary: string }> = {
  A: { name: "Ticket amount refundable; booking fee retained", summary: "Face value refunded; booking fee retained." },
  B: { name: "Ticket amount and booking fee refundable", summary: "Face value and booking fee refunded." },
  C: { name: "Refund according to applicable law", summary: "Treatment follows the mandatory law that applies to each customer." },
  D: { name: "Custom commercial policy", summary: "Terms are set out expressly by the parties." },
  E: { name: "Rescheduled event; tickets remain valid", summary: "Tickets valid for the new date; refund only where stated." },
  F: { name: "Rescheduled event; refund option", summary: "Customers may keep tickets or request a refund within a window." },
  G: { name: "Cancellation with deadlines", summary: "Refunds must be requested/processed within stated deadlines." },
  H: { name: "Force majeure cancellation", summary: "Treatment for cancellation caused by force majeure." },
};

export function variantRules(v: RefundVariant, opts: { deadlineDays?: number; fundedBy?: (typeof FUNDERS)[number] } = {}): RefundRule[] {
  const fundedBy = opts.fundedBy ?? "organiser";
  const d = opts.deadlineDays;
  const cancel: RefundReason[] = CANCELLATION_REASONS;
  const mk = (id: string, reasons: RefundRule["reasons"], label: string, outcome: Outcome): RefundRule => ({ id: `contract.${id}`, layer: "contract", reasons, label, outcome: { fundedBy, settlementReversal: true, deadlineDays: d, ...outcome } });
  switch (v) {
    case "A": return [mk("A", cancel, "Contract: ticket refundable, booking fee retained", { ticket: "refund", bookingFee: "retain", taxes: "refund", processingFee: "retain" })];
    case "B": return [mk("B", cancel, "Contract: ticket and booking fee refundable", { ticket: "refund", bookingFee: "refund", taxes: "refund", processingFee: "refund" })];
    case "C": return [mk("C", cancel, "Contract: refunds follow applicable law", { fundedBy: "organiser" })];
    case "D": return [];
    case "E": return [mk("E", ["postponement", "rescheduling", "event_date_change"], "Contract: tickets remain valid for new date", { reschedule: "tickets_valid" })];
    case "F": return [mk("F", ["postponement", "rescheduling", "event_date_change"], "Contract: refund option on reschedule", { reschedule: "refund_option", ticket: "refund", taxes: "refund", bookingFee: "retain" })];
    case "G": return [mk("G", cancel, "Contract: cancellation refunds with deadlines", { ticket: "refund", taxes: "refund", bookingFee: "retain", partial: false })];
    case "H": return [mk("H", ["force_majeure", "government_restriction"], "Contract: force majeure cancellation", { ticket: "refund", taxes: "refund", bookingFee: "retain", processingFee: "retain" })];
  }
}
