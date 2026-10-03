import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { encrypt } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { setStripeGatewayFactory, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { editOrganiserPayment, recordOrganiserPayment, setBookingFee, voidOrganiserPayment } from "@/server/accounting/manual";
import { createExpense, editExpense, voidExpense } from "@/server/accounting/expenses";
import { convert, eventAuditTrail, eventFinancials, financeOverview, organiserFinancials, settlementStatus } from "@/server/accounting/finance";
import { linkOrganiserUser, portalData } from "@/server/accounting/portal";
import { trialBalance } from "@/server/accounting/reports";
import { ctxFor, expectPg, makeOrg } from "./helpers";
import { FakeStripe } from "./stripe-fixtures";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeGatewayFactory(null); await stopBoss(); });

describe("settlement status and reporting conversion", () => {
  it("classifies due vs paid", () => {
    expect(settlementStatus(0, 0)).toBe("NOTHING_DUE");
    expect(settlementStatus(1000, 0)).toBe("NOT_SETTLED");
    expect(settlementStatus(1000, 400)).toBe("PARTIALLY_PAID");
    expect(settlementStatus(1000, 1000)).toBe("FULLY_PAID");
    expect(settlementStatus(1000, 1001)).toBe("OVERPAID");
    expect(settlementStatus(0, 50)).toBe("OVERPAID");
    expect(settlementStatus(-350, 0)).toBe("ORGANISER_OWES");
  });
  it("converts for reporting only when a rate exists, respecting currency exponents", () => {
    const fx = { reportingCurrency: "gbp", rates: { eur: "0.85", jpy: "0.0052" } };
    expect(convert(10000, "gbp", fx)).toBe(10000);
    expect(convert(10000, "eur", fx)).toBe(8500);
    expect(convert(1000, "jpy", fx)).toBe(520); // ¥1000 (no minor unit) ≈ £5.20
    expect(convert(10000, "usd", fx)).toBeNull();
    expect(convert(10000, "eur", { reportingCurrency: null, rates: {} })).toBeNull();
  });
});

async function setup() {
  const { org, user } = await makeOrg("Event Financials Test");
  const fake = new FakeStripe();
  setStripeGatewayFactory(() => fake);
  const [acc] = await db.insert(schema.stripeAccounts).values({ organisationId: org.id, livemode: false, secretKeyEnc: encrypt(`sk_test_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…abcd", status: "CONNECTED", stripeAccountId: "acct_1EVTFIN" }).returning();
  const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  // Pro-rata commission reversal on refunds (policy "booking fee refundable"); the default policy is tested separately.
  const { ensureLedgerSetup } = await import("@/server/accounting/core");
  await ensureLedgerSetup(db, org.id);
  await db.update(schema.acctSettings).set({ bookingFeeRefundable: true }).where(eq(schema.acctSettings.organisationId, org.id));
  const organiser = await createOrganiser(actor, { name: "Persian Concerts Ltd", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
  // 7 % booking fee, Stripe fees borne by Bilit — the Bilit model.
  const event = await createEvent(actor, { name: "Persian Concert London", code: `PCL-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "gbp", organiserId: organiser.id, startsOn: "2026-10-30", status: "ACTIVE", notes: null, agreement: { percentBps: 700, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
  const ctx = async () => importContext(acc as StripeAccountRow, fake);
  return { org, user, fake, actor, organiser, event, ctx };
}
type Env = Awaited<ReturnType<typeof setup>>;
const fig = async (e: Env) => (await eventFinancials(e.org.id, "test", { eventIds: [e.event.id] }))[0]!;
const balanced = async (orgId: string) => (await trialBalance(orgId, "test")).reduce((s, r) => s + r.balance, 0);

describe("event financials, settlement and profitability", () => {
  let e: Env;
  beforeAll(async () => {
    e = await setup();
    const s1 = e.fake.sale({ amount: 10000, fee: 300, currency: "gbp", description: `Order (a1) for event: Persian Concert London (${e.event.code})`, metadata: { quantity: "2" } });
    const s2 = e.fake.sale({ amount: 5000, fee: 175, currency: "gbp", description: `Order (a2) for event: Persian Concert London (${e.event.code})`, metadata: { quantity: "1" } });
    await importBalanceTransaction(await e.ctx(), s1.bt);
    await importBalanceTransaction(await e.ctx(), s2.bt);
    await importBalanceTransaction(await e.ctx(), e.fake.refund(s1.charge, 2000).bt);
  });

  it("separates ticket revenue, booking fee, organiser money and Bilit profit from actual transactions", async () => {
    const f = await fig(e);
    expect(f).toMatchObject({
      currency: "gbp", tickets: 3, orders: 2, grossSales: 15000, refunds: 2000, netSales: 13000,
      bookingFees: 700 + 350 - 140, processingFees: 475, feesRecharged: 0, organiserDue: 9300 + 4650 - 1860,
      organiserPaid: 0, remaining: 12090, bilitProfit: 910 - 475, settlement: "NOT_SETTLED", bookingFeeBps: 700,
    });
    // Money flow identity: net sales − booking fee − recharged fees − deductions = due to organiser.
    expect(f.netSales - f.bookingFees - f.feesRecharged - f.deductions).toBe(f.organiserDue);
    // P&L identity: booking fee + other revenue − Bilit-borne fees − Bilit expenses = profit.
    expect(f.bookingFees + f.eventFees + f.otherRevenue - f.bilitProcessingFees - f.expensesBilit - f.otherCosts).toBe(f.bilitProfit);
  });

  it("expenses: Bilit-borne reduce profit, organiser-borne are deducted from the settlement; deleting voids and reverses", async () => {
    const bilit = await createExpense(e.actor, { mode: "test", eventId: e.event.id, name: "Venue deposit", category: "VENUE", amount: 100, currency: "gbp", expenseDate: new Date().toISOString().slice(0, 10), description: null, borneBy: "BILIT" });
    const org = await createExpense(e.actor, { mode: "test", eventId: e.event.id, name: "Security", category: "SECURITY", amount: 200, currency: "gbp", expenseDate: new Date().toISOString().slice(0, 10), description: null, borneBy: "ORGANISER" });
    let f = await fig(e);
    expect(f).toMatchObject({ expensesBilit: 100, expensesOrganiser: 200, deductions: 200, organiserDue: 12090 - 200, bilitProfit: 435 - 100 });
    await expectPg(createExpense(e.actor, { mode: "test", eventId: e.event.id, name: "x", category: "OTHER", amount: 1, currency: "eur", expenseDate: "2026-10-01", description: null, borneBy: "BILIT" }), /event is in GBP/);
    await editExpense(e.actor, bilit.id, { amount: 150, reason: "Final invoice" });
    f = await fig(e);
    expect(f.expensesBilit).toBe(150);
    await voidExpense(e.actor, org.id, "Organiser paid security directly");
    f = await fig(e);
    expect(f).toMatchObject({ expensesOrganiser: 0, deductions: 0, organiserDue: 12090, bilitProfit: 435 - 150 });
    const [row] = await db.select().from(schema.acctEventExpenses).where(eq(schema.acctEventExpenses.id, org.id));
    expect(row).toMatchObject({ status: "VOIDED", voidReason: "Organiser paid security directly" });
    await expectPg(db.delete(schema.acctEventExpenses).where(eq(schema.acctEventExpenses.id, org.id)), /not permitted/);
    expect(await balanced(e.org.id)).toBe(0);
  });

  it("organiser payments drive the settlement status; edits re-post, deletes void", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const p = await recordOrganiserPayment(e.actor, { mode: "test", organiserId: e.organiser.id, eventId: e.event.id, amount: 5000, currency: "gbp", paymentDate: today, bankReference: "INV-1021", method: "BANK_TRANSFER", notes: null, status: "PAID" });
    expect(await fig(e)).toMatchObject({ organiserPaid: 5000, remaining: 7090, settlement: "PARTIALLY_PAID" });
    await editOrganiserPayment(e.actor, p.id, { amount: 12090, reason: "Paid the full balance" });
    expect(await fig(e)).toMatchObject({ organiserPaid: 12090, remaining: 0, settlement: "FULLY_PAID" });
    const entries = await db.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.sourceType, "organiser_payment"), eq(schema.acctJournalEntries.sourceId, p.id)));
    expect(entries.map((x) => `${x.entryType}:${x.status}`).sort()).toEqual(["ORGANISER_PAYMENT:POSTED", "ORGANISER_PAYMENT:REVERSED", "REVERSAL:POSTED"]);
    const { remittancePdf } = await import("@/server/accounting/remittance");
    const rc = await remittancePdf(e.org.id, p.id);
    expect(rc.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(rc.name).toMatch(/^RA-\d{4}-[0-9A-F]{8}-Persian-Concerts-Ltd\.pdf$/);
    const extra = await recordOrganiserPayment(e.actor, { mode: "test", organiserId: e.organiser.id, eventId: e.event.id, amount: 300, currency: "gbp", paymentDate: today, bankReference: "INV-1034", method: "BANK_TRANSFER", notes: null, status: "PAID" });
    expect((await fig(e)).settlement).toBe("OVERPAID");
    await voidOrganiserPayment(e.actor, extra.id, "Duplicate");
    expect((await fig(e)).settlement).toBe("FULLY_PAID");
    // A notes-only edit does not touch the ledger.
    const before = (await db.execute<{ n: number }>(sql`select count(*)::int n from acct_journal_entries where organisation_id = ${e.org.id}`)).rows[0]!.n;
    await editOrganiserPayment(e.actor, p.id, { notes: "Confirmed by bank", reason: "Add note" });
    expect((await db.execute<{ n: number }>(sql`select count(*)::int n from acct_journal_entries where organisation_id = ${e.org.id}`)).rows[0]!.n).toBe(before);
    expect(await balanced(e.org.id)).toBe(0);
  });

  it("changing the booking fee re-applies it to booked sales and refunds, and is audited", async () => {
    const r = await setBookingFee(e.actor, e.event.id, { percentBps: 1000, applyToExisting: true, reason: "Renegotiated to 10%" });
    expect(r.reposted).toBeGreaterThanOrEqual(2);
    const f = await fig(e);
    expect(f).toMatchObject({ bookingFeeBps: 1000, bookingFees: 1000 + 500 - 200, organiserDue: 9000 + 4500 - 1800, bilitProfit: 1300 - 475 - 150 });
    expect(f.settlement).toBe("OVERPAID"); // 12 090 was paid against a lower amount now due
    const trail = await eventAuditTrail(e.org.id, e.event.id);
    const change = trail.find((x) => x.type === "booking_fee.changed")!;
    expect(change.metadata).toMatchObject({ old: { percentBps: 700 }, new: { percentBps: 1000 }, reason: "Renegotiated to 10%" });
    expect(trail.some((x) => x.type === "organiser_payment.edited")).toBe(true);
    expect(trail.some((x) => x.type === "expense.deleted")).toBe(true);
    expect(await balanced(e.org.id)).toBe(0);
    // Future-only change leaves booked sales alone.
    await setBookingFee(e.actor, e.event.id, { percentBps: 800, applyToExisting: false, reason: "Next season" });
    expect((await fig(e)).bookingFees).toBe(1300);
  });

  it("organiser account, overview and filters use the same numbers", async () => {
    const f = await fig(e);
    const o = await organiserFinancials(e.org.id, "test", e.organiser.id);
    expect(o.eventCount).toBe(1);
    const { listOrganisers } = await import("@/server/accounting/queries");
    expect((await listOrganisers(e.org.id, {}, { limit: 10, offset: 0 })).items.find((x) => x.id === e.organiser.id)?.eventCount).toBe(1);
    expect(o.totals[0]).toMatchObject({ grossSales: f.grossSales, bookingFees: f.bookingFees, organiserDue: f.organiserDue, organiserPaid: f.organiserPaid, remaining: f.remaining });
    const ov = await financeOverview(e.org.id, "test", {});
    expect(ov.totals.find((x) => x.currency === "gbp")).toMatchObject({ grossSales: f.grossSales, bilitProfit: f.bilitProfit, bookingFees: f.bookingFees });
    expect(ov.monthly.filter((m) => m.currency === "gbp").reduce((s, m) => s + m.bilitProfit, 0)).toBe(f.bilitProfit);
    expect(await eventFinancials(e.org.id, "test", { settlement: "NOT_SETTLED" })).toHaveLength(0);
    expect(await eventFinancials(e.org.id, "test", { settlement: "OVERPAID" })).toHaveLength(1);
    expect(await eventFinancials(e.org.id, "test", { currency: "eur" })).toHaveLength(0);
  });

  it("organiser portal shows only the linked organiser's own figures, never Bilit's profit", async () => {
    await expectPg(portalData(e.org.id, e.user.id), /not linked/);
    await linkOrganiserUser(e.actor, e.organiser.id, e.user.id);
    // Portal data is live-only; this organisation has only test data, so totals are empty but access works.
    const p = await portalData(e.org.id, e.user.id);
    expect(p.organisers).toHaveLength(1);
    expect(JSON.stringify(p)).not.toMatch(/bilitProfit|processingFees|expensesBilit/);
  });
});

describe("refunds follow their sale automatically", () => {
  it("a refund imported while its sale was unmatched is re-linked and recalculated once the event exists", async () => {
    const e = await setup();
    const code = `LATE-${randomBytes(2).toString("hex").toUpperCase()}`;
    const s = e.fake.sale({ amount: 8000, fee: 200, currency: "gbp", description: `Order (z1) for event: Late Show (${code})` });
    await importBalanceTransaction(await e.ctx(), s.bt);
    const r = await importBalanceTransaction(await e.ctx(), e.fake.refund(s.charge, 3000).bt);
    expect(r.row).toMatchObject({ matchStatus: "UNMATCHED", matchReason: "ORIGINAL_UNMATCHED" });
    // Simulate a refund left behind (e.g. the sale was matched by a path that did not cascade).
    const { rematchUnmatched } = await import("@/server/accounting/manual");
    await createEvent(e.actor, { name: "Late Show", code, currency: "gbp", organiserId: e.organiser.id, startsOn: null, status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    await rematchUnmatched(e.org.id);
    const [row] = await db.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.id, r.row.id));
    expect(row).toMatchObject({ matchStatus: "MATCHED", matchMethod: "INHERITED", commissionAmount: -300, organiserAmount: -2700 });
    const [ev] = await db.select().from(schema.acctEvents).where(eq(schema.acctEvents.code, code));
    const f = (await eventFinancials(e.org.id, "test", { eventIds: [ev!.id] }))[0]!;
    expect(f).toMatchObject({ grossSales: 8000, refunds: 3000, bookingFees: 500, organiserDue: 4500 });
    expect(await balanced(e.org.id)).toBe(0);
  });
});

describe("variable booking fee from a date", () => {
  it("7 % on earlier sales, 10 % from a given date", async () => {
    const e = await setup();
    const day = 86400;
    const old = e.fake.sale({ amount: 10000, fee: 0, currency: "gbp", description: `Order (o1) for event: Persian Concert London (${e.event.code})`, created: Math.floor(Date.now() / 1000) - 3 * day });
    const now = e.fake.sale({ amount: 10000, fee: 0, currency: "gbp", description: `Order (o2) for event: Persian Concert London (${e.event.code})` });
    await importBalanceTransaction(await e.ctx(), old.bt);
    await importBalanceTransaction(await e.ctx(), now.bt);
    const today = new Date().toISOString().slice(0, 10);
    const r = await setBookingFee(e.actor, e.event.id, { percentBps: 1000, applyToExisting: true, applyFrom: today, reason: "10% from today" });
    expect(r.reposted).toBe(1);
    const rows = await db.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.eventId, e.event.id));
    expect(rows.find((x) => x.chargeId === old.charge.id)?.commissionAmount).toBe(700);
    expect(rows.find((x) => x.chargeId === now.charge.id)?.commissionAmount).toBe(1000);
    expect((await fig(e)).bookingFees).toBe(1700);
    expect(await balanced(e.org.id)).toBe(0);
  });
});

describe("booking fee added on top of the ticket price", () => {
  it("€35 ticket + 10 % = €38.50 paid → booking fee €3.50, organiser €35.00", async () => {
    const { feeIncluded } = await import("@/lib/money");
    const { saleCommission } = await import("@/server/accounting/postings");
    expect(feeIncluded(3850, 1000)).toBe(350);
    expect(feeIncluded(3745, 700)).toBe(245); // €35 + 7 %
    expect(saleCommission(3850, 120, 1, { id: "x", percentBps: 1000, percentBasis: "ADDED", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true })).toBe(350);
  });
  it("posts the fee and organiser share from actual Stripe amounts, refunds reverse it", async () => {
    const e = await setup();
    await setBookingFee(e.actor, e.event.id, { percentBps: 1000, applyToExisting: true, percentBasis: "ADDED", reason: "Fee added at checkout" });
    const s = e.fake.sale({ amount: 3850, fee: 120, currency: "gbp", description: `Order (t1) for event: Persian Concert London (${e.event.code})` });
    await importBalanceTransaction(await e.ctx(), s.bt);
    expect(await fig(e)).toMatchObject({ grossSales: 3850, bookingFees: 350, organiserDue: 3500, bilitProfit: 350 - 120 });
    await importBalanceTransaction(await e.ctx(), e.fake.refund(s.charge, 3850).bt);
    expect(await fig(e)).toMatchObject({ refunds: 3850, bookingFees: 0, organiserDue: 0 });
    expect(await balanced(e.org.id)).toBe(0);
  });
});
