import { z } from "zod";

/** Who collects, holds, processes, settles and refunds funds. Explicit; nothing here is assumed by default. */
const Party = z.enum(["bilit", "organiser", "payment_provider", "not_applicable"]);
const Bearer = z.enum(["bilit", "organiser", "customer", "shared"]);

export const MoneyFlowConfig = z.object({
  collectsTicketRevenue: Party.default("bilit"),
  holdsFunds: Party.default("bilit"),
  processesPayments: Party.default("payment_provider"),
  settlesToOrganiser: Party.default("bilit"),
  refundsCustomers: Party.default("bilit"),
  bookingFee: z.object({ enabled: z.boolean().default(true), paidBy: z.enum(["customer", "organiser"]).default("customer"), amountText: z.string().max(300).optional() }).default({ enabled: true, paidBy: "customer" }),
  processingFee: z.object({ enabled: z.boolean().default(false), borneBy: Bearer.default("shared"), amountText: z.string().max(300).optional() }).default({ enabled: false, borneBy: "shared" }),
  commission: z.object({ enabled: z.boolean().default(false), percent: z.number().min(0).max(100).optional() }).default({ enabled: false }),
  taxes: z.object({ enabled: z.boolean().default(false), responsibility: z.enum(["organiser", "bilit", "shared"]).default("organiser"), note: z.string().max(500).optional() }).default({ enabled: false, responsibility: "organiser" }),
  chargebacks: z.object({ enabled: z.boolean().default(false), borneBy: Bearer.default("organiser") }).default({ enabled: false, borneBy: "organiser" }),
  reserve: z.object({ enabled: z.boolean().default(false), percent: z.number().min(0).max(100).optional(), releaseDays: z.number().int().min(0).max(365).optional() }).default({ enabled: false }),
  settlement: z.object({ timing: z.enum(["after_event", "before_event", "rolling", "on_request"]).default("after_event"), days: z.number().int().min(0).max(180).default(7), conditions: z.array(z.string().min(1).max(300)).max(20).default([]) }).default({ timing: "after_event", days: 7, conditions: [] }),
  withheld: z.object({ enabled: z.boolean().default(false), items: z.array(z.string().min(1).max(300)).max(20).default([]) }).default({ enabled: false, items: [] }),
}).superRefine((c, ctx) => {
  if (c.commission.enabled && c.commission.percent === undefined) ctx.addIssue({ code: "custom", path: ["commission", "percent"], message: "Commission percent required" });
  if (c.reserve.enabled && c.reserve.percent === undefined) ctx.addIssue({ code: "custom", path: ["reserve", "percent"], message: "Reserve percent required" });
  if (c.withheld.enabled && c.withheld.items.length === 0) ctx.addIssue({ code: "custom", path: ["withheld", "items"], message: "List withheld items" });
});
export type MoneyFlowConfig = z.infer<typeof MoneyFlowConfig>;

const NAME: Record<string, string> = { bilit: "Bilit", organiser: "the Organiser", payment_provider: "the payment provider engaged by Bilit", not_applicable: "not applicable", customer: "the customer", shared: "Bilit and the Organiser in equal shares" };

/** Human-readable summary rows for the "money flow model" panel. */
export function moneyFlowSummary(c: MoneyFlowConfig): Array<{ label: string; value: string }> {
  return [
    { label: "Collects ticket revenue", value: NAME[c.collectsTicketRevenue]! },
    { label: "Holds funds", value: NAME[c.holdsFunds]! },
    { label: "Processes payments", value: NAME[c.processesPayments]! },
    { label: "Settles to organiser", value: NAME[c.settlesToOrganiser]! },
    { label: "Refunds customers", value: NAME[c.refundsCustomers]! },
    { label: "Booking fee", value: c.bookingFee.enabled ? `Paid by ${c.bookingFee.paidBy}` : "Not charged" },
    { label: "Processing fee", value: c.processingFee.enabled ? `Borne by ${NAME[c.processingFee.borneBy]}` : "Not specified" },
    { label: "Commission", value: c.commission.enabled ? `${c.commission.percent}%` : "None" },
    { label: "Taxes", value: c.taxes.enabled ? `Responsibility: ${c.taxes.responsibility}` : "Not specified" },
    { label: "Chargebacks", value: c.chargebacks.enabled ? `Borne by ${NAME[c.chargebacks.borneBy]}` : "Not specified" },
    { label: "Reserve", value: c.reserve.enabled ? `${c.reserve.percent}%${c.reserve.releaseDays !== undefined ? `, released after ${c.reserve.releaseDays} days` : ""}` : "None" },
    { label: "Settlement", value: `${c.settlement.timing.replace("_", " ")}, ${c.settlement.days} days` },
  ];
}

/** Variables for money-flow clauses. Disabled obligations emit a false flag so their clauses are excluded rather than invented. */
export function moneyFlowVariables(c: MoneyFlowConfig): Record<string, string | boolean> {
  return {
    mf_collects: NAME[c.collectsTicketRevenue]!, mf_holds: NAME[c.holdsFunds]!, mf_processes: NAME[c.processesPayments]!,
    mf_settles: NAME[c.settlesToOrganiser]!, mf_refunds: NAME[c.refundsCustomers]!,
    booking_fee_enabled: c.bookingFee.enabled, booking_fee_paid_by: c.bookingFee.paidBy === "customer" ? "the customer" : "the Organiser", booking_fee_terms: c.bookingFee.amountText ?? "",
    processing_fee_enabled: c.processingFee.enabled, processing_fee_borne_by: NAME[c.processingFee.borneBy]!, processing_fee_terms: c.processingFee.amountText ?? "",
    commission_enabled: c.commission.enabled, commission: c.commission.percent !== undefined ? String(c.commission.percent) : "",
    taxes_enabled: c.taxes.enabled, taxes_responsibility: NAME[c.taxes.responsibility === "shared" ? "shared" : c.taxes.responsibility]!, taxes_note: c.taxes.note ?? "",
    chargebacks_enabled: c.chargebacks.enabled, chargebacks_borne_by: NAME[c.chargebacks.borneBy]!,
    reserve_enabled: c.reserve.enabled, reserve_percent: c.reserve.percent !== undefined ? String(c.reserve.percent) : "", reserve_release_days: c.reserve.releaseDays !== undefined ? String(c.reserve.releaseDays) : "",
    settlement_timing: c.settlement.timing.replace("_", " "), settlement_days: String(c.settlement.days), settlement_conditions: c.settlement.conditions.join("; "), settlement_has_conditions: c.settlement.conditions.length > 0,
    withheld_enabled: c.withheld.enabled, withheld_items: c.withheld.items.join("; "),
  };
}
