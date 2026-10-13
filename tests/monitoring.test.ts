import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { stopBoss } from "@/server/jobs";
import { ensureLedgerSetup } from "@/server/accounting/core";
import { createBill } from "@/server/accounting/books";
import { eventAnomalies, expenseSpike, findDuplicateBills, getMonitorSettings, MONITOR_DEFAULTS, updateMonitorSettings, webhookAlerts } from "@/server/accounting/monitor";
import { projectCash } from "@/server/accounting/forecast";
import { dueSchedule, splitDueNow } from "@/server/accounting/position";
import { periodChecklist, periodRange } from "@/server/accounting/period-close";
import { setPeriodStatus } from "@/server/accounting/manual";
import { ctxFor, expectPg, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { await stopBoss(); });

const ev = (o: Partial<Parameters<typeof eventAnomalies>[0][number]> & { eventId: string }) => ({
  eventName: o.eventId, eventCode: o.eventId.toUpperCase(), currency: "eur", orders: 50, grossSales: 100_000, refunds: 0, chargebacks: 0, netSales: 100_000,
  processingFees: 2_000, feesRecharged: 0, bilitRevenue: 10_000, bilitProfit: 8_000, profitShare: 0, ...o,
});

describe("event anomalies (coded checks)", () => {
  const s = MONITOR_DEFAULTS;
  it("flags a refund rate above the threshold, and only for events with enough orders", () => {
    const a = eventAnomalies([ev({ eventId: "a", refunds: 20_000 }), ev({ eventId: "b", refunds: 20_000, orders: 3 })], s);
    expect(a.map((x) => x.id)).toEqual(["mon-refund-a"]);
    expect(a[0]!.detail).toMatch(/20\.0%/);
  });
  it("flags Stripe fees well above the median of same-currency events, not other currencies", () => {
    const a = eventAnomalies([ev({ eventId: "a" }), ev({ eventId: "b" }), ev({ eventId: "c", processingFees: 3_500 }), ev({ eventId: "d", currency: "gbp", processingFees: 9_000 })], s);
    expect(a.filter((x) => x.id.startsWith("mon-fee")).map((x) => x.id)).toEqual(["mon-fee-c"]);
  });
  it("flags losses and margins far below typical", () => {
    const a = eventAnomalies([ev({ eventId: "a" }), ev({ eventId: "b" }), ev({ eventId: "c", bilitProfit: 2_000 }), ev({ eventId: "d", bilitProfit: -500 })], s);
    expect(a.map((x) => x.id).sort()).toEqual(["mon-loss-d", "mon-margin-c"]);
  });
  it("margin is judged before partner profit share", () => {
    const a = eventAnomalies([ev({ eventId: "a" }), ev({ eventId: "b" }), ev({ eventId: "c", bilitProfit: 6_800, profitShare: 1_200 })], s);
    expect(a).toEqual([]);
  });
});

describe("duplicate supplier documents", () => {
  const b = (id: string, o: Partial<Parameters<typeof findDuplicateBills>[0][number]> = {}) => ({ id, supplierName: "Hetzner Online GmbH", invoiceNumber: null, invoiceDate: "2026-10-01", currency: "eur", totalAmount: 4_000, ...o });
  it("same invoice number = duplicate even with different dates/amounts; company suffixes ignored", () => {
    const d = findDuplicateBills([b("1", { invoiceNumber: "R-1 001" }), b("2", { supplierName: "hetzner online", invoiceNumber: "r-1001", invoiceDate: "2026-11-30", totalAmount: 1 })], 7);
    expect(d).toMatchObject([{ kind: "SAME_INVOICE_NUMBER", ids: ["1", "2"] }]);
  });
  it("same supplier + amount within the window, but not when both have different invoice numbers", () => {
    expect(findDuplicateBills([b("1"), b("2", { invoiceDate: "2026-10-06" })], 7)).toMatchObject([{ kind: "SAME_AMOUNT_DAYS" }]);
    expect(findDuplicateBills([b("1"), b("2", { invoiceDate: "2026-10-20" })], 7)).toEqual([]);
    expect(findDuplicateBills([b("1", { invoiceNumber: "A" }), b("2", { invoiceNumber: "B" })], 7)).toEqual([]);
    expect(findDuplicateBills([b("1"), b("2", { status: "VOIDED" })], 7)).toEqual([]);
  });
});

describe("webhooks and running costs", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("never received / stopped while activity continued / failures", () => {
    expect(webhookAlerts({ lastWebhookAt: null, lastActivityAt: null, failedLast7d: 0, now, staleHours: 24 }).map((x) => x.id)).toEqual(["webhook"]);
    expect(webhookAlerts({ lastWebhookAt: new Date(now - 48 * 3_600_000), lastActivityAt: new Date(now - 3_600_000), failedLast7d: 0, now, staleHours: 24 }).map((x) => x.id)).toEqual(["webhook-stale"]);
    expect(webhookAlerts({ lastWebhookAt: new Date(now - 48 * 3_600_000), lastActivityAt: new Date(now - 72 * 3_600_000), failedLast7d: 2, now, staleHours: 24 }).map((x) => x.id)).toEqual(["webhook-failed"]);
  });
  it("average uses only the months that have data (no false alarm for a new currency)", () => {
    expect(expenseSpike([{ month: "2026-09", amount: 10_000 }, { month: "2026-10", amount: 12_000 }], "2026-10", 1.5)).toBeNull();
    expect(expenseSpike([{ month: "2026-08", amount: 10_000 }, { month: "2026-09", amount: 10_000 }, { month: "2026-10", amount: 16_000 }], "2026-10", 1.5)).toEqual({ current: 16_000, average: 10_000 });
    expect(expenseSpike([{ month: "2026-10", amount: 16_000 }], "2026-10", 1.5)).toBeNull();
  });
});

describe("cash forecast", () => {
  it("organiser dues are scheduled by event date after organiser-level payments (oldest first)", () => {
    const evs = [{ startsOn: "2026-10-01", remaining: 1_000 }, { startsOn: "2026-11-01", remaining: 3_000 }, { startsOn: null, remaining: -200 }];
    expect(dueSchedule(evs, 500)).toEqual([{ startsOn: "2026-10-01", amount: 300 }, { startsOn: "2026-11-01", amount: 3_000 }]);
    expect(splitDueNow(evs, 500, "2026-10-13")).toEqual({ dueNow: 300, later: 3_000 });
  });
  it("walks day by day: past-dated flows land today, releases add, payments subtract, running costs accrue", () => {
    const f = projectCash({ currency: "gbp", today: "2026-10-13", start: 10_000, held: 1_000, dailyCost: 100, horizons: [7, 30],
      flows: [{ date: "2026-10-01", amount: -2_000, kind: "bills" }, { date: "2026-10-15", amount: 5_000, kind: "stripe_release" }, { date: "2026-10-25", amount: -15_000, kind: "organisers" }, { date: "2027-03-01", amount: -9, kind: "bills" }] });
    const [d7, d30] = f.horizons;
    expect(d7).toMatchObject({ days: 7, date: "2026-10-20", inflows: 5_000, outflows: 2_000, estimated: 700, balance: 12_300, free: 11_300 });
    expect(d30).toMatchObject({ days: 30, balance: 10_000 + 5_000 - 2_000 - 15_000 - 3_000, free: -6_000 });
    expect(d30!.byKind).toMatchObject({ bills: -2_000, stripe_release: 5_000, organisers: -15_000, running_costs: -3_000 });
    expect(f.firstShort).toBe("2026-10-25");
    expect(f.low).toEqual({ date: "2026-11-12", balance: -6_000 });
    expect(f.beyond).toBe(-9);
  });
});

describe("with the database", () => {
  let actor: { orgId: string; userId: string; ctx: ReturnType<typeof ctxFor> };
  let acc: Record<string, string>;
  beforeAll(async () => {
    const { org, user } = await makeOrg("Monitoring Test");
    actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    acc = await ensureLedgerSetup(db, org.id) as unknown as Record<string, string>;
  });
  it("thresholds: defaults, partial update, validation", async () => {
    expect(await getMonitorSettings(actor.orgId)).toEqual(MONITOR_DEFAULTS);
    expect(await updateMonitorSettings(actor, { refundRatePct: 25, organiserPayDays: 3 })).toMatchObject({ refundRatePct: 25, organiserPayDays: 3, minOrders: 10 });
    expect((await getMonitorSettings(actor.orgId)).refundRatePct).toBe(25);
    await expect(updateMonitorSettings(actor, { refundRatePct: 0 })).rejects.toThrow();
  });
  it("a probable duplicate supplier invoice is refused until confirmed", async () => {
    const base = { mode: "live" as const, kind: "BILL" as const, supplierName: "Print Co Ltd", supplierVat: null, country: "GB", invoiceNumber: "P-77", invoiceDate: "2026-10-02", dueDate: "2026-10-30", currency: "gbp", netAmount: 50_000, vatAmount: 0, accountId: acc.software!, eventId: null, description: null, paidFrom: null, paidDate: null, paymentReference: null };
    const first = await createBill(actor, base);
    await expectPg(createBill(actor, { ...base, supplierName: "Print Co", invoiceDate: "2026-10-09" }), /duplicate/);
    await expectPg(createBill(actor, { ...base, invoiceNumber: null, invoiceDate: "2026-10-05" }), /duplicate/);
    const ok = await createBill(actor, { ...base, invoiceNumber: null, invoiceDate: "2026-10-05", allowDuplicate: true });
    expect(ok.id).not.toBe(first.id);
    // A different amount from the same supplier is fine.
    await createBill(actor, { ...base, invoiceNumber: "P-78", netAmount: 12_345 });
  });
  it("month-end checklist lists open items; closing needs acknowledgement; future months cannot close", async () => {
    expect(periodRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    await expectPg(periodChecklist(actor.orgId, "2099-01"), /not started/);
    const c = await periodChecklist(actor.orgId, "2026-10", "2026-10-20");
    expect(c.items.map((x) => x.code)).toEqual(expect.arrayContaining(["MONTH_NOT_OVER", "MISSING_RECEIPTS"]));
    expect(c.items.find((x) => x.code === "AUDIT_CHAIN")).toBeUndefined();
    const sep = await periodChecklist(actor.orgId, "2026-09");
    expect(sep.ready).toBe(true);
    await setPeriodStatus(actor, { period: "2026-09", action: "close", reason: "September done" });
    await expectPg(setPeriodStatus(actor, { period: "2026-10", action: "close", reason: "Close early" }), /still open/);
  });
});
