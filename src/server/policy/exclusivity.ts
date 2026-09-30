import { z } from "zod";

/** Contractual exclusivity policy (a clause, not a statutory rule). Configured by the authorised Bilit user. */
export const ExclusivityConfig = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["exclusive", "non_exclusive"]).default("exclusive"),
  scopeKind: z.enum(["listed_events", "all_events"]).default("listed_events"),
  events: z.array(z.string().min(1).max(200)).max(100).default([]),
  inventoryScope: z.enum(["all_inventory", "percentage", "categories"]).default("all_inventory"),
  inventoryPercent: z.number().min(1).max(100).optional(),
  inventoryCategories: z.array(z.string().min(1).max(120)).max(50).default([]),
  approvedExceptions: z.array(z.string().min(1).max(500)).max(50).default([]),
  approvedChannels: z.array(z.string().min(1).max(200)).max(50).default([]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  territory: z.string().min(1).max(300).default("Worldwide"),
  breachConsequences: z.array(z.enum(["notice", "suspension", "fee_recovery", "liquidated_sum", "termination", "damages"])).default(["notice"]),
  liquidatedSumText: z.string().max(500).optional(),
  cureDays: z.number().int().min(0).max(180).default(14),
}).superRefine((c, ctx) => {
  if (!c.enabled) return;
  if (c.scopeKind === "listed_events" && c.events.length === 0) ctx.addIssue({ code: "custom", path: ["events"], message: "List at least one event, or choose all events" });
  if (c.inventoryScope === "percentage" && c.inventoryPercent === undefined) ctx.addIssue({ code: "custom", path: ["inventoryPercent"], message: "Percentage required" });
  if (c.inventoryScope === "categories" && c.inventoryCategories.length === 0) ctx.addIssue({ code: "custom", path: ["inventoryCategories"], message: "List at least one ticket category" });
  if (c.startDate && c.endDate && c.endDate < c.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date is before start date" });
  if (c.breachConsequences.includes("liquidated_sum") && !c.liquidatedSumText) ctx.addIssue({ code: "custom", path: ["liquidatedSumText"], message: "Describe the liquidated sum" });
});
export type ExclusivityConfig = z.infer<typeof ExclusivityConfig>;

const list = (xs: string[], none: string) => (xs.length ? xs.join("; ") : none);
const CONSEQ: Record<string, string> = {
  notice: "written notice of breach", suspension: "suspension of Bilit services for the affected event", fee_recovery: "recovery of fees and costs Bilit incurred",
  liquidated_sum: "payment of the agreed sum", termination: "termination of this Agreement", damages: "damages",
};

/** Variables the exclusivity clauses consume. Only emitted when enabled: nothing is invented for unselected policy. */
export function exclusivityVariables(c: ExclusivityConfig): Record<string, string | boolean> {
  if (!c.enabled) return { exclusive_ticketing: false };
  return {
    exclusive_ticketing: c.mode === "exclusive",
    exclusivity_mode: c.mode === "exclusive" ? "exclusive" : "non-exclusive",
    exclusivity_events: c.scopeKind === "all_events" ? "all events of the Organiser covered by this Agreement" : list(c.events, "the Events listed in this Agreement"),
    exclusivity_inventory: c.inventoryScope === "all_inventory" ? "all ticket inventory for the Covered Events" : c.inventoryScope === "percentage" ? `${c.inventoryPercent}% of ticket inventory for the Covered Events` : `the following ticket categories: ${list(c.inventoryCategories, "")}`,
    exclusivity_exceptions: list(c.approvedExceptions, "none"),
    exclusivity_channels: list(c.approvedChannels, "none"),
    exclusivity_start: c.startDate ?? "the Effective Date",
    exclusivity_end: c.endDate ?? "the end of the last Covered Event",
    exclusivity_territory: c.territory,
    exclusivity_breach: c.breachConsequences.map((k) => CONSEQ[k]).join(", "),
    exclusivity_liquidated: c.liquidatedSumText ?? "",
    exclusivity_cure_days: String(c.cureDays),
    exclusivity_has_cure: c.cureDays > 0,
    exclusivity_liquidated_sum: c.breachConsequences.includes("liquidated_sum"),
  };
}
