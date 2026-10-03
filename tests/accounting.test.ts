import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { encrypt, sha256 } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { applyBps, formatMoney, parseMajor, percentToBps, prorate, toDecimalString } from "@/lib/money";
import { eventNameFromDescription } from "@/server/accounting/queries";
import { DEFAULT_RULES, ensureLedgerSetup, type Mode } from "@/server/accounting/core";
import { extractEventCode } from "@/server/accounting/matcher";
import { btPostings, classifyBt, type Agreement } from "@/server/accounting/postings";
import { setStripeGatewayFactory, setWebhookSecret, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { createAdjustment, matchTransaction, rematchUnmatched, recordOrganiserPayment, setPeriodStatus, unmatchTransaction, voidOrganiserPayment } from "@/server/accounting/manual";
import { createSyncRun, executeRun, processPayout, processStripeEvent } from "@/server/accounting/sync";
import { dashboard, dimensionSummary, organiserStatement, salesRows, trialBalance } from "@/server/accounting/reports";
import { ctxFor, expectPg, makeOrg } from "./helpers";
import { btObj, chargeObj, FakeStripe } from "./stripe-fixtures";
import * as webhookRoute from "@/app/api/webhooks/stripe/route";
import * as dashRoute from "@/app/api/accounting/dashboard/route";
import * as organisersRoute from "@/app/api/accounting/organisers/route";
import * as txRoute from "@/app/api/accounting/transactions/[id]/route";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeGatewayFactory(null); await stopBoss(); });

const AG: Agreement = { id: "a", percentBps: 500, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true };
const sum = (p: { amount: number }[]) => p.reduce((s, x) => s + x.amount, 0);

describe("money (integer minor units, no floats)", () => {
  it("formats and parses exactly, including zero- and three-decimal currencies", () => {
    expect(toDecimalString(1099, "eur")).toBe("10.99");
    expect(toDecimalString(-5, "gbp")).toBe("-0.05");
    expect(toDecimalString(1500, "jpy")).toBe("1500");
    expect(toDecimalString(12345, "kwd")).toBe("12.345");
    expect(parseMajor("1,234.50", "eur")).toBe(123450);
    expect(parseMajor("0.1", "usd") + parseMajor("0.2", "usd")).toBe(30); // 0.1 + 0.2 is exact in minor units
    expect(parseMajor("1500", "jpy")).toBe(1500);
    expect(() => parseMajor("10.5", "jpy")).toThrow();
    expect(() => parseMajor("1.234", "eur")).toThrow();
    expect(formatMoney(1099, "eur")).toBe("€10.99");
    expect(formatMoney(150000, "jpy")).toBe("JP¥150,000"); // en-GB style
    expect(formatMoney(-4000, "gbp")).toBe("-£40.00");
  });
  it("percentages are basis points with half-away-from-zero rounding", () => {
    expect(percentToBps("5")).toBe(500);
    expect(percentToBps("2.75")).toBe(275);
    expect(applyBps(10000, 500)).toBe(500);
    expect(applyBps(999, 250)).toBe(25); // 24.975 -> 25
    expect(applyBps(-999, 250)).toBe(-25);
    expect(applyBps(Number.MAX_SAFE_INTEGER, 10000)).toBe(Number.MAX_SAFE_INTEGER); // BigInt intermediate, no overflow
    expect(prorate(500, -4000, 10000)).toBe(-200);
  });
});

describe("event code extraction", () => {
  const known = new Set(["EVT-BER-2026", "ABC123", "EVT-FRA-2026"]);
  const rules = [{ type: "METADATA" as const, key: "event_code" }, { type: "EXACT" as const }];
  it("finds a known code anywhere in the description", () => {
    expect(extractEventCode({ description: "Blood In Blood Out Berlin - EVT-BER-2026" }, rules, known)).toMatchObject({ ok: true, code: "EVT-BER-2026", method: "EXACT" });
    expect(extractEventCode({ description: "Ticket purchase - Event ABC123" }, rules, known)).toMatchObject({ ok: true, code: "ABC123" });
    expect(extractEventCode({ description: "abc123 - VIP Ticket" }, rules, known)).toMatchObject({ ok: true, code: "ABC123" });
  });
  it("prefers metadata over the description", () => {
    expect(extractEventCode({ description: "ABC123", metadata: { Event_Code: "evt-fra-2026" } }, rules, known)).toMatchObject({ ok: true, code: "EVT-FRA-2026", method: "METADATA" });
  });
  it("reports missing, unknown and ambiguous codes instead of guessing", () => {
    expect(extractEventCode({ description: "Donation" }, rules, known)).toEqual({ ok: false, reason: "NO_CODE" });
    expect(extractEventCode({ metadata: { event_code: "EVT-XXX-1" } }, rules, known)).toMatchObject({ ok: false, reason: "CODE_NOT_FOUND", code: "EVT-XXX-1" });
    expect(extractEventCode({ description: "EVT-BER-2026 + EVT-FRA-2026 bundle" }, rules, known)).toMatchObject({ ok: false, reason: "AMBIGUOUS" });
  });
  it("supports prefix and regex rules", () => {
    expect(extractEventCode({ description: "Order 77 / EVT-NEW-9" }, [{ type: "PREFIX", prefix: "EVT-" }], known)).toMatchObject({ ok: false, reason: "CODE_NOT_FOUND", code: "EVT-NEW-9" });
    expect(extractEventCode({ description: "Order 77 [code:abc123]" }, [{ type: "REGEX", pattern: "\\[code:([A-Za-z0-9-]+)\\]" }], known)).toMatchObject({ ok: true, code: "ABC123", method: "REGEX" });
  });
});

describe("Bilit order descriptions", () => {
  const samples: Array<[string, string]> = [
    ["Order (sL93xoK) for event: Blood In Blood Out Berlin (B41-0091), by Hussein Kaawar", "B41-0091"],
    ["Order (NH9MTbq) for event: Chris D'Elia - Go For It! The Tour - Gothenburg (B17-0073), by Sofia Schacherer", "B17-0073"],
    ["Order (XJcdPgW) for event: Blood in Blood out Frankfurt  (B41-0089), by Simona Granata", "B41-0089"],
    ["Order (E3tu9ui) for event: Blood in Blood Out - Stuttgart (B9-0093), by Angelina Boheim", "B9-0093"],
  ];
  it("detects the event code even before the event exists in Bilit", () => {
    for (const [d, code] of samples) expect(extractEventCode({ description: d }, DEFAULT_RULES, new Set())).toMatchObject({ ok: false, reason: "CODE_NOT_FOUND", code, method: "REGEX" });
  });
  it("takes the event name from the text after 'event:' and before the code", () => {
    expect(samples.map(([d, code]) => eventNameFromDescription(d, code))).toEqual(["Blood In Blood Out Berlin", "Chris D'Elia - Go For It! The Tour - Gothenburg", "Blood in Blood out Frankfurt", "Blood in Blood Out - Stuttgart"]);
  });
  it("matches once the event exists, and ignores the order id in brackets", () => {
    for (const [d, code] of samples) expect(extractEventCode({ description: d }, DEFAULT_RULES, new Set([code, "SL93XOK"]))).toMatchObject({ ok: true, code, method: "REGEX" });
  });
});

describe("posting rules (double entry)", () => {
  const m = { eventId: "e", organiserId: "o", agreement: AG };
  it("every Stripe transaction kind produces balanced lines", () => {
    for (const [type, cat, amount, fee] of [["charge", "charge", 10000, 320], ["refund", "refund", -4000, 0], ["adjustment", "dispute", -6000, 1500], ["adjustment", "dispute_reversal", 6000, -1500], ["payout", "payout", -9680, 0], ["payout_failure", "payout_reversal", 9680, 0], ["stripe_fee", "fee", -250, 0], ["reserve_transaction", "other", -100, 0]] as const) {
      for (const matched of [m, null]) {
        const r = btPostings({ kind: classifyBt(type, cat), amount, fee, net: amount - fee, matched, original: { amount: 10000, commission: 500 } });
        expect(sum(r.postings), `${type}/${cat}`).toBe(0);
      }
    }
  });
  it("sale: gross, fee and net stay separate; commission and organiser payable follow the agreement", () => {
    const r = btPostings({ kind: "SALE", amount: 10000, fee: 320, net: 9680, matched: m, ticketQuantity: 1 });
    const by = (k: string) => r.postings.filter((p) => p.account === k).reduce((s, p) => s + p.amount, 0);
    expect(by("ticket_sales")).toBe(-10000);
    expect(by("stripe_fees")).toBe(320);
    expect(by("stripe_balance")).toBe(9680);
    expect(r.commission).toBe(500);
    expect(by("organiser_payable")).toBe(-9180); // €100 − €5 commission − €3.20 Stripe fee
    expect(r.organiserAmount).toBe(9180);
  });
  it("commission models: % of net, fixed per ticket, Bilit bears fees", () => {
    const net = btPostings({ kind: "SALE", amount: 10000, fee: 320, net: 9680, matched: { ...m, agreement: { ...AG, percentBasis: "NET" } } });
    expect(net.commission).toBe(484);
    const fixed = btPostings({ kind: "SALE", amount: 10000, fee: 320, net: 9680, ticketQuantity: 3, matched: { ...m, agreement: { ...AG, percentBps: 0, fixedPerTicket: 200 } } });
    expect(fixed.commission).toBe(600);
    const bilitFees = btPostings({ kind: "SALE", amount: 10000, fee: 320, net: 9680, matched: { ...m, agreement: { ...AG, stripeFeesBorneBy: "BILIT" } } });
    expect(bilitFees.organiserAmount).toBe(9500);
  });
  it("rejects Stripe amounts that do not add up", () => {
    expect(() => btPostings({ kind: "SALE", amount: 100, fee: 3, net: 96, matched: null })).toThrow(/inconsistent/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
async function setup(mode: Mode = "test") {
  const { org, user } = await makeOrg("Bilit Finance Test");
  const fake = new FakeStripe();
  fake.livemode = mode === "live";
  setStripeGatewayFactory(() => fake);
  const [acc] = await db.insert(schema.stripeAccounts).values({ organisationId: org.id, livemode: mode === "live", secretKeyEnc: encrypt(`sk_${mode}_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…abcd", status: "CONNECTED", stripeAccountId: "acct_1TESTBILIT" }).returning();
  const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const organiser = await createOrganiser(actor, { name: "Example Events GmbH", email: "finance@example.test", companyName: "Example Events GmbH", vatNumber: "DE123456789", address: null, internalRef: `ORG-${randomBytes(3).toString("hex")}`, notes: null, active: true, bankDetails: { accountHolder: "Example Events GmbH", iban: "DE89370400440532013000", bic: "COBADEFFXXX", bankName: null, notes: null } });
  const event = await createEvent(actor, { name: "Blood In Blood Out Berlin", code: "EVT-BER-2026", currency: "eur", organiserId: organiser.id, startsOn: "2026-10-20", status: "ACTIVE", notes: null, agreement: { percentBps: 500, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
  const ctx = async () => importContext(acc!, fake);
  return { org, user, fake, acc: acc as StripeAccountRow, actor, organiser, event, ctx };
}
type Env = Awaited<ReturnType<typeof setup>>;
const balances = async (e: Env, mode: Mode = "test") => {
  const tb = await trialBalance(e.org.id, mode);
  const accts = await db.select().from(schema.acctAccounts).where(eq(schema.acctAccounts.organisationId, e.org.id));
  const key = new Map(accts.map((a) => [a.id, a.systemKey ?? a.code]));
  const out: Record<string, number> = {};
  for (const r of tb) out[`${key.get(r.accountId)}:${r.currency}`] = (out[`${key.get(r.accountId)}:${r.currency}`] ?? 0) + r.balance;
  return out;
};
const entryCount = async (orgId: string) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from acct_journal_entries where organisation_id = ${orgId}`)).rows[0]!.n;
const ledgerBalanced = async (orgId: string) => (await db.execute<{ d: string; c: string }>(sql`select coalesce(sum(debit),0)::text d, coalesce(sum(credit),0)::text c from acct_journal_lines where organisation_id = ${orgId}`)).rows[0]!;

describe("Stripe import → ledger", () => {
  let e: Env;
  beforeAll(async () => { e = await setup(); });

  it("a ticket sale is matched by event code and booked gross / fee / net / commission / organiser payable", async () => {
    const { bt } = e.fake.sale({ amount: 10000, fee: 320, description: "Blood In Blood Out Berlin - EVT-BER-2026" });
    const r = await importBalanceTransaction(await e.ctx(), bt);
    expect(r.created).toBe(true);
    expect(r.row).toMatchObject({ kind: "SALE", amount: 10000, fee: 320, net: 9680, eventId: e.event.id, organiserId: e.organiser.id, matchStatus: "MATCHED", matchMethod: "EXACT", reconciliationStatus: "MATCHED", commissionAmount: 500, organiserAmount: 9180 });
    const b = await balances(e);
    expect(b["ticket_sales:eur"]).toBe(-10000);
    expect(b["stripe_fees:eur"]).toBe(320);
    expect(b["stripe_fee_recharges:eur"]).toBe(-320);
    expect(b["stripe_balance:eur"]).toBe(9680);
    expect(b["organiser_payable:eur"]).toBe(-9180);
    const d = await dashboard(e.org.id, "test", {});
    expect(d.currencies[0]).toMatchObject({ currency: "eur", grossSales: 10000, stripeFees: 320, commission: 500, bilitRevenue: 500, bilitProfit: 500, organiserOutstanding: 9180, stripeBalance: 9680 });
  });

  it("importing the same Stripe transaction again (webhook + sync) never duplicates anything", async () => {
    const { bt } = e.fake.sale({ amount: 5000, fee: 170, description: "EVT-BER-2026 VIP" });
    const c = await e.ctx();
    await importBalanceTransaction(c, bt);
    const before = await entryCount(e.org.id);
    const again = await importBalanceTransaction(c, bt);
    await importBalanceTransaction(await e.ctx(), bt);
    expect(again.created).toBe(false);
    expect(await entryCount(e.org.id)).toBe(before);
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.balanceTransactionId, bt.id));
    expect(n[0]!.n).toBe(1);
  });

  it("partial refund: linked to the original, commission reversed pro rata, organiser payable reduced", async () => {
    const { charge, bt } = e.fake.sale({ amount: 10000, fee: 320, description: "EVT-BER-2026" });
    await importBalanceTransaction(await e.ctx(), bt);
    const { bt: rbt } = e.fake.refund(charge, 4000);
    const r = await importBalanceTransaction(await e.ctx(), rbt);
    expect(r.row).toMatchObject({ kind: "REFUND", amount: -4000, chargeId: charge.id, eventId: e.event.id, matchMethod: "INHERITED", reconciliationStatus: "REFUND", commissionAmount: -200, organiserAmount: -3800 });
    const sales = await salesRows(e.org.id, "test", {}, { limit: 50, offset: 0 });
    const row = sales.find((s) => s.stripePayment === charge.id)!;
    expect(row).toMatchObject({ gross: 10000, refunded: 4000, netGross: 6000, stripeFee: 320, net: 5680, commission: 300 });
  });

  it("disputes are booked as chargebacks (separately from refunds), dispute fee included", async () => {
    const { charge, bt } = e.fake.sale({ amount: 10000, fee: 320, description: "EVT-BER-2026" });
    await importBalanceTransaction(await e.ctx(), bt);
    const { dispute, bt: dbt } = e.fake.dispute(charge, 10000, 1500);
    const r = await importBalanceTransaction(await e.ctx(), dbt);
    expect(r.row).toMatchObject({ kind: "DISPUTE", reconciliationStatus: "DISPUTE", commissionAmount: -500, organiserAmount: -(9500 + 1500) });
    const [d] = await db.select().from(schema.stripeDisputes).where(eq(schema.stripeDisputes.disputeId, dispute.id));
    expect(d).toMatchObject({ amount: 10000, reason: "fraudulent", status: "needs_response", eventId: e.event.id, organiserId: e.organiser.id, accountingStatus: "OPEN" });
    const s = (await dimensionSummary(e.org.id, "test", { eventId: e.event.id }))[0]!;
    expect(s.chargebacks).toBe(10000);
    expect(s.refunds).toBe(4000);
  });

  it("the whole ledger stays balanced", async () => {
    const t = await ledgerBalanced(e.org.id);
    expect(t.d).toBe(t.c);
  });
});

describe("matching, unmatched transactions and manual resolution", () => {
  let e: Env;
  beforeAll(async () => { e = await setup(); });

  it("missing / unknown / ambiguous codes and currency mismatch end up unmatched (never discarded)", async () => {
    const c = await e.ctx();
    const none = await importBalanceTransaction(c, e.fake.sale({ amount: 2000, fee: 50, description: "Gift card" }).bt);
    const unknown = await importBalanceTransaction(c, e.fake.sale({ amount: 2000, fee: 50, description: "x", metadata: { event_code: "EVT-NOPE-1" } }).bt);
    const usd = await importBalanceTransaction(c, e.fake.sale({ amount: 2000, fee: 50, currency: "usd", description: "EVT-BER-2026" }).bt);
    expect(none.row).toMatchObject({ matchStatus: "UNMATCHED", matchReason: "NO_CODE", reconciliationStatus: "UNMATCHED", eventId: null });
    expect(unknown.row).toMatchObject({ matchReason: "CODE_NOT_FOUND", eventCode: "EVT-NOPE-1" });
    expect(usd.row).toMatchObject({ matchReason: "CURRENCY_MISMATCH", eventId: e.event.id, organiserId: null });
    const b = await balances(e);
    expect(b["unallocated_receipts:eur"]).toBe(-4000); // money kept in an unallocated liability, not lost
    expect(b["unallocated_receipts:usd"]).toBe(-2000);
  });

  it("an unmatched sale is matched automatically on re-sync once its event exists (with reversal, no duplicate)", async () => {
    const { bt } = e.fake.sale({ amount: 3000, fee: 100, description: "x", metadata: { event_code: "EVT-FRA-2026" } });
    expect((await importBalanceTransaction(await e.ctx(), bt)).row.matchStatus).toBe("UNMATCHED");
    await createEvent(e.actor, { name: "Frankfurt", code: "evt-fra-2026", currency: "eur", organiserId: e.organiser.id, startsOn: null, status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    const r = await importBalanceTransaction(await e.ctx(), bt);
    expect(r.newlyMatched).toBe(true);
    expect(r.row).toMatchObject({ matchStatus: "MATCHED", matchMethod: "METADATA", commissionAmount: 300, postingVersion: 2 });
    const entries = await db.select().from(schema.acctJournalEntries).where(eq(schema.acctJournalEntries.stripeBalanceTransactionId, bt.id));
    expect(entries.map((x) => x.entryType).sort()).toEqual(["REVERSAL", "SALE", "SALE_UNALLOCATED"]);
    expect(entries.find((x) => x.entryType === "SALE_UNALLOCATED")!.status).toBe("REVERSED");
    expect((await importBalanceTransaction(await e.ctx(), bt)).newlyMatched).toBe(false);
  });

  it("sales imported before their event exists are matched automatically when it is created", async () => {
    const { bt } = e.fake.sale({ amount: 4500, fee: 150, description: "Order (sL93xoK) for event: Blood In Blood Out Berlin (B41-0091), by Hussein Kaawar" });
    const before = (await importBalanceTransaction(await e.ctx(), bt)).row;
    expect(before).toMatchObject({ matchStatus: "UNMATCHED", matchReason: "CODE_NOT_FOUND", eventCode: "B41-0091" });
    await createEvent(e.actor, { name: "Blood In Blood Out Berlin", code: "B41-0091", currency: "eur", organiserId: e.organiser.id, startsOn: null, status: "ACTIVE", notes: null, agreement: { percentBps: 500, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    expect((await rematchUnmatched(e.org.id)).matched).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.id, before.id));
    expect(after).toMatchObject({ matchStatus: "MATCHED", eventCode: "B41-0091", commissionAmount: 225, reconciliationStatus: "MATCHED" });
  });

  it("duplicate event codes are rejected (case-insensitive)", async () => {
    await expect(createEvent(e.actor, { name: "Dup", code: "evt-ber-2026", currency: "eur", organiserId: null, startsOn: null, status: "ACTIVE", notes: null, agreement: { percentBps: 0, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } })).rejects.toThrow(/already in use/);
  });

  it("manual match assigns transaction → event → organiser, is audited, and refunds follow", async () => {
    const { charge, bt } = e.fake.sale({ amount: 8000, fee: 250, description: "Walk-in sale" });
    const row = (await importBalanceTransaction(await e.ctx(), bt)).row;
    const { bt: rbt } = e.fake.refund(charge, 8000);
    expect((await importBalanceTransaction(await e.ctx(), rbt)).row).toMatchObject({ reconciliationStatus: "PARTIAL", matchReason: "ORIGINAL_UNMATCHED" });
    const m = await matchTransaction(e.actor, row.id, { eventId: e.event.id, reason: "Box office sale for Berlin", override: false });
    expect(m).toMatchObject({ matchStatus: "MATCHED", matchMethod: "MANUAL", reconciliationStatus: "MATCHED", organiserId: e.organiser.id, commissionAmount: 400 });
    const [refundRow] = await db.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.balanceTransactionId, rbt.id));
    expect(refundRow).toMatchObject({ matchStatus: "MATCHED", matchMethod: "INHERITED", reconciliationStatus: "REFUND", commissionAmount: -400 });
    const hist = await db.select().from(schema.acctMatchHistory).where(eq(schema.acctMatchHistory.balanceTransactionRef, row.id));
    expect(hist[0]).toMatchObject({ action: "MATCH", toEventId: e.event.id, reason: "Box office sale for Berlin", userId: e.user.id });
    const audits = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.organisationId, e.org.id), eq(schema.auditEvents.eventType, "accounting.transaction.matched")));
    expect(audits.length).toBe(1);
    // A re-sync never overrides a manual decision.
    await unmatchTransaction(e.actor, row.id, "Wrong event");
    const again = await importBalanceTransaction(await e.ctx(), bt);
    expect(again.row).toMatchObject({ matchStatus: "UNMATCHED", matchMethod: "MANUAL" });
  });

  it("currency mismatch needs an explicit override", async () => {
    const { bt } = e.fake.sale({ amount: 2000, fee: 80, currency: "gbp", description: "manual" });
    const row = (await importBalanceTransaction(await e.ctx(), bt)).row;
    await expect(matchTransaction(e.actor, row.id, { eventId: e.event.id, reason: "test", override: false })).rejects.toThrow(/override/);
    expect((await matchTransaction(e.actor, row.id, { eventId: e.event.id, reason: "Agreed GBP sale", override: true })).matchReason).toBe("OVERRIDE_CURRENCY_MISMATCH");
  });
});

describe("payouts, organiser payments, adjustments, periods", () => {
  let e: Env;
  beforeAll(async () => { e = await setup(); });

  it("a payout is not a sale: Stripe balance → in transit → bank, reconciled against its transactions", async () => {
    const s1 = e.fake.sale({ amount: 10000, fee: 320, description: "EVT-BER-2026" });
    const s2 = e.fake.sale({ amount: 5000, fee: 170, description: "EVT-BER-2026" });
    const c = await e.ctx();
    await importBalanceTransaction(c, s1.bt); await importBalanceTransaction(c, s2.bt);
    const { payout, bt } = e.fake.payout(9680 + 4830, [s1.bt.id, s2.bt.id]);
    await importBalanceTransaction(c, bt);
    await processPayout(c, payout);
    await processPayout(c, payout); // idempotent
    const b = await balances(e);
    expect(b["stripe_balance:eur"]).toBe(0);
    expect(b["payouts_in_transit:eur"] ?? 0).toBe(0);
    expect(b["bank:eur"]).toBe(14510);
    expect(b["ticket_sales:eur"]).toBe(-15000); // unchanged by the payout
    const [p] = await db.select().from(schema.stripePayouts).where(eq(schema.stripePayouts.payoutId, payout.id));
    expect(p).toMatchObject({ status: "paid", reconciliationStatus: "MATCHED", includedCount: 2, includedNet: 14510 });
    const linked = await db.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.payoutId, payout.id));
    expect(linked.length).toBe(3);
  });

  it("organiser payments reduce the outstanding balance; voiding reverses instead of deleting", async () => {
    const before = (await dimensionSummary(e.org.id, "test", { organiserId: e.organiser.id }))[0]!;
    expect(before.organiserOutstanding).toBe(9180 + 4830 - 250); // 5000 sale: 5000 − 250 commission − 170 fee
    const pay = await recordOrganiserPayment(e.actor, { mode: "test", organiserId: e.organiser.id, eventId: e.event.id, amount: 10000, currency: "eur", paymentDate: "2026-10-02", bankReference: "BANK-2026-001", method: "BANK_TRANSFER", notes: null, status: "PAID" });
    const mid = (await dimensionSummary(e.org.id, "test", { organiserId: e.organiser.id }))[0]!;
    expect(mid).toMatchObject({ organiserPayments: 10000, organiserOutstanding: before.organiserOutstanding - 10000, organiserPayable: before.organiserPayable });
    const st = await organiserStatement(e.org.id, "test", e.organiser.id, "eur", {}, { limit: 50, offset: 0 });
    expect(st.rows.at(-1)).toMatchObject({ payments: 10000, balance: before.organiserOutstanding - 10000 });
    await voidOrganiserPayment(e.actor, pay.id, "Entered twice");
    const after = (await dimensionSummary(e.org.id, "test", { organiserId: e.organiser.id }))[0]!;
    expect(after.organiserOutstanding).toBe(before.organiserOutstanding);
    const [row] = await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.id, pay.id));
    expect(row).toMatchObject({ status: "VOIDED", voidReason: "Entered twice" });
    await expectPg(db.delete(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.id, pay.id)), /not permitted/);
  });

  it("manual adjustments post double entry and are idempotent per key", async () => {
    const accts = await ensureLedgerSetup(db, e.org.id);
    const input = { mode: "test" as const, date: "2026-10-02", currency: "eur", amount: 50000, debitAccountId: accts.bank, creditAccountId: accts.other_revenue, eventId: e.event.id, organiserId: null, description: "Sponsorship income", reason: "Sponsor contract SP-1", reference: "SP-1" };
    const a1 = await createAdjustment(e.actor, input, "k1");
    const a2 = await createAdjustment(e.actor, input, "k1");
    expect(a2.id).toBe(a1.id);
    await expect(createAdjustment(e.actor, { ...input, debitAccountId: accts.stripe_balance }, "k2")).rejects.toThrow(/Stripe Balance/);
    const s = (await dimensionSummary(e.org.id, "test", { eventId: e.event.id }))[0]!;
    expect(s.otherRevenue).toBe(50000);
  });

  it("closed periods reject postings; late Stripe activity lands in the open period", async () => {
    await setPeriodStatus(e.actor, { period: "2026-08", action: "close", reason: "Month end" });
    const accts = await ensureLedgerSetup(db, e.org.id);
    await expect(createAdjustment(e.actor, { mode: "test", date: "2026-08-15", currency: "eur", amount: 100, debitAccountId: accts.other_expenses, creditAccountId: accts.bank, eventId: null, organiserId: null, description: "Venue", reason: "late invoice", reference: null }, "k3")).rejects.toThrow(/closed/);
    const { bt } = e.fake.sale({ amount: 1000, fee: 30, description: "EVT-BER-2026", created: Math.floor(Date.parse("2026-08-15T10:00:00Z") / 1000) });
    const r = await importBalanceTransaction(await e.ctx(), bt);
    const [entry] = await db.select().from(schema.acctJournalEntries).where(eq(schema.acctJournalEntries.id, r.row.postedEntryId!));
    expect(entry!.entryDate).not.toMatch(/^2026-08/);
    expect(entry!.sourceDate.toISOString()).toBe("2026-08-15T10:00:00.000Z");
    await setPeriodStatus(e.actor, { period: "2026-08", action: "reopen", reason: "Correction" });
  });

  it("the ledger is append-only and every entry must balance (database-enforced)", async () => {
    const [line] = await db.select().from(schema.acctJournalLines).where(eq(schema.acctJournalLines.organisationId, e.org.id)).limit(1);
    await expectPg(db.update(schema.acctJournalLines).set({ debit: 1 }).where(eq(schema.acctJournalLines.id, line!.id)), /not permitted/);
    await expectPg(db.delete(schema.acctJournalEntries).where(eq(schema.acctJournalEntries.id, line!.entryId)), /cannot be deleted/);
    await expectPg(db.update(schema.acctJournalEntries).set({ description: "edited" }).where(eq(schema.acctJournalEntries.id, line!.entryId)), /immutable/);
    const accts = await ensureLedgerSetup(db, e.org.id);
    await expectPg(db.transaction(async (tx) => {
      const [en] = await tx.insert(schema.acctJournalEntries).values({ organisationId: e.org.id, livemode: false, entryType: "ADJUSTMENT", entryDate: "2026-10-02", sourceDate: new Date(), currency: "eur", description: "bad", sourceType: "adjustment", idempotencyKey: `bad:${Math.random()}` }).returning();
      await tx.insert(schema.acctJournalLines).values([{ entryId: en!.id, organisationId: e.org.id, accountId: accts.bank, debit: 100 }, { entryId: en!.id, organisationId: e.org.id, accountId: accts.other_revenue, credit: 99 }]);
    }), /unbalanced/);
  });
});

describe("multi-currency and test/live separation", () => {
  it("GBP, USD and zero-decimal JPY are booked in their own currency, never converted", async () => {
    const e = await setup();
    const mk = (code: string, currency: string) => createEvent(e.actor, { name: code, code, currency, organiserId: e.organiser.id, startsOn: null, status: "ACTIVE", notes: null, agreement: { percentBps: 500, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    await mk("EVT-LON-1", "gbp"); await mk("EVT-NYC-1", "usd"); await mk("EVT-TYO-1", "jpy");
    const c = await e.ctx();
    for (const [code, cur, amt, fee] of [["EVT-LON-1", "gbp", 2500, 58], ["EVT-NYC-1", "usd", 4000, 146], ["EVT-TYO-1", "jpy", 15000, 540]] as const) await importBalanceTransaction(c, e.fake.sale({ amount: amt, fee, currency: cur, description: code }).bt);
    const d = await dashboard(e.org.id, "test", {});
    const by = Object.fromEntries(d.currencies.map((x) => [x.currency, x]));
    expect(by.gbp).toMatchObject({ grossSales: 2500, stripeFees: 58, commission: 125 });
    expect(by.usd).toMatchObject({ grossSales: 4000, commission: 200 });
    expect(by.jpy).toMatchObject({ grossSales: 15000, stripeFees: 540, commission: 750 });
  });

  it("test and live data never mix", async () => {
    const t = await setup("test");
    await importBalanceTransaction(await t.ctx(), t.fake.sale({ amount: 10000, fee: 320, description: "EVT-BER-2026" }).bt);
    const [live] = await db.insert(schema.stripeAccounts).values({ organisationId: t.org.id, livemode: true, secretKeyEnc: encrypt("sk_live_x"), status: "CONNECTED" }).returning();
    const liveFake = new FakeStripe(); liveFake.livemode = true;
    await importBalanceTransaction(await importContext(live!, liveFake), liveFake.sale({ amount: 7777, fee: 200, description: "EVT-BER-2026" }).bt);
    expect((await dashboard(t.org.id, "test", {})).currencies[0]!.grossSales).toBe(10000);
    expect((await dashboard(t.org.id, "live", {})).currencies[0]!.grossSales).toBe(7777);
    // A live charge returned for the test account is refused.
    const wrong = liveFake.sale({ amount: 100, fee: 3, description: "x" });
    await expect(importBalanceTransaction(await t.ctx(), { ...wrong.bt, source: wrong.charge } as Stripe.BalanceTransaction)).rejects.toThrow(/other mode/);
  });
});

describe("synchronisation runs", () => {
  it("imports every page, counts results, records per-transaction errors, and is idempotent", async () => {
    const e = await setup();
    for (let i = 0; i < 7; i++) e.fake.sale({ amount: 1000 + i, fee: 30, description: i === 6 ? "no code" : "EVT-BER-2026" });
    const bad = e.fake.sale({ amount: 999, fee: 30, description: "EVT-BER-2026" });
    e.fake.failOn.add(bad.charge.id);
    const run1 = await createSyncRun({ orgId: e.org.id, mode: "test", kind: "FULL", userId: e.user.id, ctx: ctxFor() });
    await executeRun(run1.id);
    const [r1] = await db.select().from(schema.acctSyncRuns).where(eq(schema.acctSyncRuns.id, run1.id));
    expect(r1).toMatchObject({ status: "PARTIAL", discovered: 8, imported: 7, existing: 0, unmatched: 1, errors: 1 });
    const entries = await entryCount(e.org.id);
    e.fake.failOn.clear();
    const retry = await createSyncRun({ orgId: e.org.id, mode: "test", kind: "RETRY" });
    await executeRun(retry.id);
    const [r2] = await db.select().from(schema.acctSyncRuns).where(eq(schema.acctSyncRuns.id, retry.id));
    expect(r2).toMatchObject({ status: "SUCCEEDED", imported: 1, errors: 0 });
    const run3 = await createSyncRun({ orgId: e.org.id, mode: "test", kind: "FULL" });
    await executeRun(run3.id);
    const [r3] = await db.select().from(schema.acctSyncRuns).where(eq(schema.acctSyncRuns.id, run3.id));
    expect(r3).toMatchObject({ status: "SUCCEEDED", discovered: 8, imported: 0, existing: 8 });
    expect(await entryCount(e.org.id)).toBe(entries + 1);
    const recon = (r3!.summary as { reconciliation: { ledgerErrors: number; currencies: Array<{ ledgerDifference: number; stripeDifference: number }> } }).reconciliation;
    expect(recon.ledgerErrors).toBe(0);
    expect(recon.currencies[0]).toMatchObject({ ledgerDifference: 0, stripeDifference: 0 });
  });

  it("a refund whose original sale is outside the synced range pulls the original in first", async () => {
    const e = await setup();
    const { charge } = e.fake.sale({ amount: 6000, fee: 200, description: "EVT-BER-2026", created: 1_700_000_000 });
    const { bt: rbt } = e.fake.refund(charge, 6000);
    const r = await importBalanceTransaction(await e.ctx(), rbt);
    expect(r.row).toMatchObject({ reconciliationStatus: "REFUND", eventId: e.event.id });
  });
});

describe("webhook endpoint", () => {
  const post = (raw: string, sig?: string) => new NextRequest("http://localhost:3000/api/webhooks/stripe", { method: "POST", body: raw, headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) } });
  const route = { params: Promise.resolve({}) };

  it("verifies the signature, records the event once, and processing re-fetches from Stripe", async () => {
    const e = await setup();
    const secret = `whsec_${randomBytes(18).toString("hex")}`;
    await setWebhookSecret({ orgId: e.org.id, userId: e.user.id, mode: "test", secret, ctx: ctxFor() });
    const { charge } = e.fake.sale({ amount: 4200, fee: 140, description: "EVT-BER-2026" });
    const raw = JSON.stringify({ id: `evt_${randomBytes(8).toString("hex")}`, object: "event", type: "charge.succeeded", livemode: false, created: Math.floor(Date.now() / 1000), api_version: "2026-09-30.endive", data: { object: { id: charge.id, object: "charge", amount: 1 } } });
    const sig = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload: raw, secret });
    const r1 = await webhookRoute.POST(post(raw, sig), route);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: true });
    const r2 = await webhookRoute.POST(post(raw, sig), route);
    expect(await r2.json()).toEqual({ received: true, duplicate: true });
    const [ev] = await db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.objectId, charge.id));
    await processStripeEvent(ev!.id);
    const [row] = await db.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.chargeId, charge.id));
    expect(row).toMatchObject({ amount: 4200, fee: 140, matchStatus: "MATCHED" }); // amounts from the API, not the payload ("amount: 1")
    const [acc] = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, e.acc.id));
    expect(acc!.lastWebhookType).toBe("charge.succeeded");
  });

  it("rejects missing, invalid and tampered signatures", async () => {
    const e = await setup();
    const secret = `whsec_${randomBytes(18).toString("hex")}`;
    await setWebhookSecret({ orgId: e.org.id, userId: e.user.id, mode: "test", secret, ctx: ctxFor() });
    const raw = JSON.stringify({ id: "evt_tamper", object: "event", type: "charge.succeeded", livemode: false, created: 1, data: { object: { id: "ch_x" } } });
    const sig = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload: raw, secret });
    expect((await webhookRoute.POST(post(raw), route)).status).toBe(400);
    expect((await webhookRoute.POST(post(raw, "t=1,v1=deadbeef"), route)).status).toBe(400);
    expect((await webhookRoute.POST(post(raw.replace("ch_x", "ch_y"), sig), route)).status).toBe(400);
    const wrongSecret = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload: raw, secret: "whsec_other_secret_value" });
    expect((await webhookRoute.POST(post(raw, wrongSecret), route)).status).toBe(400);
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stripeEvents).where(eq(schema.stripeEvents.eventId, "evt_tamper"));
    expect(n[0]!.n).toBe(0);
  });

  it("a failed payment is recorded without touching the ledger", async () => {
    const e = await setup();
    const c = chargeObj({ amount: 5000, status: "failed", description: "EVT-BER-2026", pi: "pi_failed_1" });
    e.fake.charges.set(c.id, c);
    e.fake.intents.set("pi_failed_1", { id: "pi_failed_1", object: "payment_intent", latest_charge: c.id, metadata: {}, description: null } as unknown as Stripe.PaymentIntent);
    const [ev] = await db.insert(schema.stripeEvents).values({ organisationId: e.org.id, stripeAccountRef: e.acc.id, livemode: false, eventId: "evt_pf_1", type: "payment_intent.payment_failed", objectId: "pi_failed_1", stripeCreatedAt: new Date() }).returning();
    await processStripeEvent(ev!.id);
    const [ch] = await db.select().from(schema.stripeCharges).where(eq(schema.stripeCharges.chargeId, c.id));
    expect(ch).toMatchObject({ status: "failed", failureCode: "card_declined", paid: false });
    expect(await entryCount(e.org.id)).toBe(0);
  });
});

describe("authorization", () => {
  async function keyFor(orgId: string, userId: string, permissions: string[]) {
    const prefix = randomBytes(5).toString("hex");
    const secret = `bes_live_${prefix}_${randomBytes(24).toString("base64url")}`;
    await db.insert(schema.apiKeys).values({ organisationId: orgId, createdBy: userId, name: "test", prefix, keyHash: sha256(secret), permissions });
    return secret;
  }
  const req = (url: string, key: string, json?: unknown) => new NextRequest(`http://localhost:3000${url}`, { method: json ? "POST" : "GET", headers: { authorization: `Bearer ${key}`, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const none = { params: Promise.resolve({}) };

  it("finance endpoints need accounting permissions; viewers cannot mutate; tenants are isolated", async () => {
    const e = await setup();
    const noPerm = await keyFor(e.org.id, e.user.id, ["contracts.view"]);
    const viewer = await keyFor(e.org.id, e.user.id, ["accounting.view"]);
    expect((await dashRoute.GET(req("/api/accounting/dashboard", noPerm), none)).status).toBe(403);
    expect((await dashRoute.GET(req("/api/accounting/dashboard", viewer), none)).status).toBe(200);
    expect((await organisersRoute.POST(req("/api/accounting/organisers", viewer, { name: "X" }), none)).status).toBe(403);
    const r = await importBalanceTransaction(await e.ctx(), e.fake.sale({ amount: 100, fee: 3, description: "EVT-BER-2026" }).bt);
    const other = await setup();
    const otherKey = await keyFor(other.org.id, other.user.id, ["accounting.view"]);
    expect((await txRoute.GET(req(`/api/accounting/transactions/${r.row.id}`, otherKey), { params: Promise.resolve({ id: r.row.id }) })).status).toBe(404);
    const mine = await txRoute.GET(req(`/api/accounting/transactions/${r.row.id}`, viewer), { params: Promise.resolve({ id: r.row.id }) });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).not.toMatch(/sk_(test|live)_|secret_key|whsec_/);
  });
});

describe("fixture sanity", () => {
  it("balance transaction fixtures follow Stripe's amount = net + fee", () => {
    const b = btObj({ type: "charge", amount: 100, fee: 3, source: "ch_1" });
    expect(b.net + b.fee).toBe(b.amount);
  });
});
