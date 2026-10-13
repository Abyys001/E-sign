import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { acctAudit, getAcctSettings, isLive, type Mode } from "./core";
import type { EventFinanceRow } from "./finance";
import type { Alert } from "./position";

/**
 * Coded financial checks with configurable thresholds. They complement the reconciliation alerts on the Financial
 * Overview (position.ts) and the bookkeeping checks (accountant.ts); they never change data. Each rule is a pure
 * function (unit-tested) so a genuine accounting error can be told apart from normal business variation:
 *   - refund rate per event above a threshold;
 *   - actual Stripe fee % of an event well above the median of comparable events (same currency);
 *   - event margin far below the median, or an event losing money;
 *   - possible duplicate supplier invoices / expenses (same invoice number, or same supplier + amount within N days);
 *   - Stripe webhooks that stopped arriving, or failed to process.
 * Events with fewer than `minOrders` orders are skipped: a handful of sales says nothing about a rate.
 */
export const MonitorSettings = z.object({
  refundRatePct: z.number().min(1).max(100).default(15),
  minOrders: z.number().int().min(1).max(10_000).default(10),
  feePctOverMedian: z.number().min(0.1).max(20).default(1),
  marginDropPct: z.number().min(5).max(100).default(50),
  expenseSpikeX: z.number().min(1.1).max(20).default(1.5),
  duplicateBillDays: z.number().int().min(0).max(90).default(7),
  webhookStaleHours: z.number().int().min(1).max(720).default(24),
  // Cash-flow forecast assumptions
  organiserPayDays: z.number().int().min(-60).max(120).default(0), // organisers are paid N days after their event
  forecastRunRate: z.boolean().default(true), // include estimated running costs (average of recent months)
});
export type MonitorSettings = z.infer<typeof MonitorSettings>;
export const MonitorSettingsPatch = MonitorSettings.partial().strict();
export const MONITOR_DEFAULTS: MonitorSettings = MonitorSettings.parse({});

export async function getMonitorSettings(orgId: string): Promise<MonitorSettings> {
  await getAcctSettings(orgId);
  const [s] = await db.select({ v: schema.acctSettings.monitorSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  const stored = MonitorSettings.partial().safeParse(s?.v ?? {});
  return { ...MONITOR_DEFAULTS, ...(stored.success ? stored.data : {}) };
}

export async function updateMonitorSettings(a: { orgId: string; userId: string; ctx: RequestContext }, patch: z.infer<typeof MonitorSettingsPatch>) {
  const before = await getMonitorSettings(a.orgId);
  const next = MonitorSettings.parse({ ...before, ...patch });
  await db.transaction(async (tx) => {
    await tx.update(schema.acctSettings).set({ monitorSettings: next, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: "monitor_settings.updated", entity: "settings", entityId: "monitor", old: before, new: next });
  });
  return next;
}

// ---------- pure rules (unit-tested) ----------

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const pct = (x: number) => `${(Math.round(x * 10) / 10).toFixed(1)}%`;

type EventLike = Pick<EventFinanceRow, "eventId" | "eventName" | "eventCode" | "currency" | "orders" | "grossSales" | "refunds" | "chargebacks" | "netSales" | "processingFees" | "feesRecharged" | "bilitRevenue" | "bilitProfit" | "profitShare">;

/** Per-event refund, Stripe-fee and margin checks. Fees and margins are compared within one currency (Stripe pricing and fee levels differ by market). */
export function eventAnomalies(events: EventLike[], s: Pick<MonitorSettings, "refundRatePct" | "minOrders" | "feePctOverMedian" | "marginDropPct">): Alert[] {
  const out: Alert[] = [];
  const sized = events.filter((e) => e.orders >= s.minOrders && e.grossSales > 0);
  // Stripe fee as % of what customers paid (actual fees from Stripe, before any recharge to the organiser).
  const feePct = (e: EventLike) => (e.processingFees / e.grossSales) * 100;
  // Bilit margin before partner shares: profit / Bilit's own revenue. Kept per event so events of any size compare.
  const margin = (e: EventLike) => (e.bilitRevenue > 0 ? ((e.bilitProfit + e.profitShare) / e.bilitRevenue) * 100 : null);
  for (const cur of new Set(sized.map((e) => e.currency))) {
    const evs = sized.filter((e) => e.currency === cur);
    const feeMed = median(evs.map(feePct));
    const margins = evs.map(margin).filter((m): m is number => m !== null);
    const marMed = median(margins);
    for (const e of evs) {
      const href = `/accounting/events/${e.eventId}`, label = `${e.eventCode} ${e.eventName}`;
      const refundRate = ((e.refunds + e.chargebacks) / e.grossSales) * 100;
      if (refundRate > s.refundRatePct) out.push({ id: `mon-refund-${e.eventId}`, severity: refundRate >= 50 ? "warning" : "info", title: `High refund rate — ${label}`, detail: `${pct(refundRate)} of sales refunded or charged back (threshold ${s.refundRatePct}%). Normal for a cancelled or moved event; otherwise check why.`, currency: cur, amount: e.refunds + e.chargebacks, href });
      if (evs.length >= 3 && feePct(e) - feeMed > s.feePctOverMedian) out.push({ id: `mon-fee-${e.eventId}`, severity: "warning", title: `Stripe fees unusually high — ${label}`, detail: `Stripe took ${pct(feePct(e))} of sales vs ${pct(feeMed)} typical for ${cur.toUpperCase()} events. Often non-EU / premium cards or currency conversion; check the event's transactions.`, currency: cur, amount: e.processingFees, href });
      const m = margin(e);
      if (m !== null && e.bilitProfit + e.profitShare < 0) out.push({ id: `mon-loss-${e.eventId}`, severity: "warning", title: `Event is losing money — ${label}`, detail: `Bilit's costs on this event are higher than its fees (margin ${pct(m)}).`, currency: cur, amount: e.bilitProfit + e.profitShare, href });
      else if (m !== null && margins.length >= 3 && marMed > 0 && m < marMed * (1 - s.marginDropPct / 100)) out.push({ id: `mon-margin-${e.eventId}`, severity: "info", title: `Low margin — ${label}`, detail: `Bilit keeps ${pct(m)} of its fees on this event vs ${pct(marMed)} typical (threshold: ${s.marginDropPct}% below). Check fee %, refunds and expenses.`, currency: cur, amount: e.bilitProfit + e.profitShare, href });
    }
  }
  return out;
}

export type BillLike = { id: string; supplierName: string; invoiceNumber: string | null; invoiceDate: string; currency: string; totalAmount: number; status?: string };
export type BillDuplicate = { kind: "SAME_INVOICE_NUMBER" | "SAME_AMOUNT_DAYS"; ids: string[]; supplierName: string; currency: string; amount: number; detail: string };
const norm = (s: string) => s.toLowerCase().replace(/\b(ltd|limited|llc|gmbh|inc|plc|bv|b\.v\.)\b/g, "").replace(/[^a-z0-9]/g, "");
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Possible duplicate supplier invoices / expenses (voided ones are ignored). */
export function findDuplicateBills(bills: BillLike[], days: number): BillDuplicate[] {
  const live = bills.filter((b) => b.status !== "VOIDED");
  const out: BillDuplicate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i]!, b = live[j]!;
    if (norm(a.supplierName) !== norm(b.supplierName) || !norm(a.supplierName)) continue;
    const key = [a.id, b.id].sort().join("|");
    if (seen.has(key)) continue;
    const num = (x: BillLike) => x.invoiceNumber?.trim().toLowerCase().replace(/\s+/g, "") ?? "";
    if (num(a) && num(a) === num(b)) { seen.add(key); out.push({ kind: "SAME_INVOICE_NUMBER", ids: [a.id, b.id], supplierName: a.supplierName, currency: a.currency, amount: a.totalAmount, detail: `${a.supplierName} invoice #${a.invoiceNumber} is recorded twice (${a.invoiceDate} and ${b.invoiceDate})` }); continue; }
    if (a.currency === b.currency && a.totalAmount === b.totalAmount && dayDiff(a.invoiceDate, b.invoiceDate) <= days && !(num(a) && num(b))) {
      seen.add(key); out.push({ kind: "SAME_AMOUNT_DAYS", ids: [a.id, b.id], supplierName: a.supplierName, currency: a.currency, amount: a.totalAmount, detail: `Two ${a.supplierName} documents for the same amount on ${a.invoiceDate} and ${b.invoiceDate}` });
    }
  }
  return out;
}

/** Webhooks that worked before but stopped while Stripe activity continued, and webhook events that failed to process. */
export function webhookAlerts(a: { lastWebhookAt: Date | null; lastActivityAt: Date | null; failedLast7d: number; now: number; staleHours: number }): Alert[] {
  const out: Alert[] = [];
  if (!a.lastWebhookAt) out.push({ id: "webhook", severity: "info", title: "Stripe webhooks are not arriving", detail: "Data relies on the 30-minute sync, so the newest payments can be up to 30 minutes late.", href: "/accounting/stripe" });
  else {
    const ageH = (a.now - a.lastWebhookAt.getTime()) / 3_600_000;
    if (ageH > a.staleHours && a.lastActivityAt && a.lastActivityAt > a.lastWebhookAt) out.push({ id: "webhook-stale", severity: "warning", title: "Stripe webhooks stopped arriving", detail: `Last webhook ${Math.round(ageH)} hours ago, but Stripe activity has been imported since. Check the webhook endpoint in Stripe; the 30-minute sync still keeps the books up to date.`, href: "/accounting/stripe" });
  }
  if (a.failedLast7d > 0) out.push({ id: "webhook-failed", severity: "warning", title: "Stripe webhook events failed", detail: `${a.failedLast7d} webhook event(s) failed to process in the last 7 days. A Stripe sync (Retry) re-imports them.`, href: "/accounting/stripe/sync" });
  return out;
}

/** This month's running costs vs the average of the previous months that have data (up to 3). */
export function expenseSpike(rows: Array<{ month: string; amount: number }>, thisMonth: string, x: number): { current: number; average: number } | null {
  const cm = rows.find((r) => r.month === thisMonth)?.amount ?? 0, prev = rows.filter((r) => r.month < thisMonth);
  if (!prev.length) return null;
  const avg = prev.reduce((s, r) => s + r.amount, 0) / prev.length;
  return avg > 0 && cm > avg * x ? { current: cm, average: avg } : null;
}

// ---------- data ----------

/** Monitor alerts for the Financial Overview: event anomalies, duplicate supplier documents, webhook health. */
export async function monitorAlerts(orgId: string, mode: Mode, events: EventFinanceRow[], s: MonitorSettings, acc: { id: string; lastWebhookAt: Date | null } | null): Promise<Alert[]> {
  const live = isLive(mode);
  const [bills, activity, failed] = await Promise.all([
    db.select({ id: schema.acctBills.id, supplierName: schema.acctBills.supplierName, invoiceNumber: schema.acctBills.invoiceNumber, invoiceDate: schema.acctBills.invoiceDate, currency: schema.acctBills.currency, totalAmount: schema.acctBills.totalAmount, status: schema.acctBills.status })
      .from(schema.acctBills).where(and(eq(schema.acctBills.organisationId, orgId), eq(schema.acctBills.livemode, live), sql`${schema.acctBills.status} <> 'VOIDED'`)),
    acc ? db.execute<{ at: string | null }>(sql`select max(created_at)::text as at from stripe_balance_transactions where stripe_account_ref = ${acc.id}`) : null,
    acc ? db.execute<{ n: number }>(sql`select count(*)::int as n from stripe_events where stripe_account_ref = ${acc.id} and status = 'FAILED' and received_at >= now() - interval '7 days'`) : null,
  ]);
  const out = eventAnomalies(events, s);
  for (const d of findDuplicateBills(bills, s.duplicateBillDays)) out.push({ id: `mon-dupbill-${d.ids.join("-")}`, severity: d.kind === "SAME_INVOICE_NUMBER" ? "critical" : "warning", title: `Possible duplicate supplier invoice — ${d.supplierName}`, detail: d.detail, currency: d.currency, amount: d.amount, href: "/accounting/books/invoices" });
  if (acc) {
    const at = activity?.rows[0]?.at;
    out.push(...webhookAlerts({ lastWebhookAt: acc.lastWebhookAt, lastActivityAt: at ? new Date(at) : null, failedLast7d: failed?.rows[0]?.n ?? 0, now: Date.now(), staleHours: s.webhookStaleHours }));
  }
  return out;
}
