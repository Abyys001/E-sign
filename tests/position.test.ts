import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { encrypt } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { setStripeGatewayFactory, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { recordOrganiserPayment, voidOrganiserPayment } from "@/server/accounting/manual";
import { cashFlow, convertMinor, currencyPosition, financialPosition, findDuplicatePayments, splitDueNow, type CashSource, type Liability } from "@/server/accounting/position";
import { ctxFor, makeOrg } from "./helpers";
import { FakeStripe } from "./stripe-fixtures";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeGatewayFactory(null); await stopBoss(); });

const src = (o: Partial<CashSource> & Pick<CashSource, "currency" | "amount">): CashSource => ({ id: Math.random().toString(36), provider: "stripe", label: "x", availableNow: true, status: "VERIFIED", source: "t", asOf: null, ...o });
const liab = (o: Partial<Liability> & Pick<Liability, "currency" | "amount">): Liability => ({ key: "organisers", dueNow: o.amount, status: "VERIFIED", accountCodes: ["2000"], ...o });

describe("financial position — pure rules", () => {
  it("remaining = verified cash − all liabilities; receivables and other currencies are never counted as cash", () => {
    const p = currencyPosition("gbp",
      [src({ currency: "gbp", amount: 20000 }), src({ currency: "gbp", amount: 5000, availableNow: false }), src({ currency: "eur", amount: 99999 })],
      [liab({ currency: "gbp", amount: 18000 }), liab({ key: "profit_share", currency: "gbp", amount: 1000 }), liab({ key: "unallocated", currency: "gbp", amount: 500, dueNow: 0, status: "REVIEW" })],
      [{ key: "organisers", currency: "gbp", amount: 7000, status: "VERIFIED" }]);
    expect(p).toMatchObject({ cash: 25000, cashAvailableNow: 20000, cashRestricted: 5000, liabilities: 19500, liabilitiesDueNow: 19000, organisersOwed: 18000, otherLiabilities: 1500, receivables: 7000, remaining: 5500, remainingNow: 1000, shortfall: 0, shortfallNow: 0, status: "REVIEW" });
  });

  it("reports the exact shortfall when debts exceed cash", () => {
    const p = currencyPosition("gbp", [src({ currency: "gbp", amount: 10000 })], [liab({ currency: "gbp", amount: 12500 })], []);
    expect(p).toMatchObject({ remaining: -2500, shortfall: 2500, shortfallNow: 2500 });
  });

  it("splits an organiser balance into due now / later; organiser-level payments go to the oldest events first", () => {
    const evs = [{ startsOn: "2026-06-01", remaining: 1000 }, { startsOn: "2026-09-01", remaining: 3000 }, { startsOn: "2026-12-01", remaining: 2000 }];
    expect(splitDueNow(evs, 0, "2026-10-13")).toEqual({ dueNow: 4000, later: 2000 });
    expect(splitDueNow(evs, 2500, "2026-10-13")).toEqual({ dueNow: 1500, later: 2000 });
    expect(splitDueNow(evs, 4500, "2026-10-13")).toEqual({ dueNow: 0, later: 1500 });
    // An event where the organiser owes Bilit (negative) is a credit against the others.
    expect(splitDueNow([{ startsOn: "2026-06-01", remaining: -300 }, { startsOn: "2026-07-01", remaining: 1000 }], 0, "2026-10-13")).toEqual({ dueNow: 700, later: 0 });
    // Parts always add up to the balance.
    const s = splitDueNow(evs, 1234, "2026-10-13");
    expect(s.dueNow + s.later).toBe(6000 - 1234);
  });

  it("flags duplicate organiser payments: same reference, same amount within 3 days, payout into Bilit's own account", () => {
    const base = { organiserId: "o1", organiserName: "Pegasus", currency: "gbp", method: "STRIPE_TRANSFER" };
    const f = findDuplicatePayments([
      { ...base, id: "a", amount: 400000, paymentDate: "2026-10-06", reference: "po_1UNdgn" },
      { ...base, id: "b", amount: 400000, paymentDate: "2026-10-07", reference: "Wise 2417781233" },
      { ...base, id: "c", amount: 1000, paymentDate: "2026-08-01", reference: "INV-77" },
      { ...base, id: "d", amount: 2000, paymentDate: "2026-08-20", reference: "inv-77" },
      { ...base, id: "e", amount: 5000, paymentDate: "2026-01-01", reference: null },
      { ...base, id: "f", amount: 5000, paymentDate: "2026-02-01", reference: null },
    ], new Set(["po_1UNdgn"]));
    expect(f.map((x) => `${x.kind}:${x.paymentIds.join("+")}`).sort()).toEqual(["PAYOUT_TO_OWN_ACCOUNT:a", "SAME_AMOUNT_DAYS:a+b", "SAME_REFERENCE:c+d"]);
    expect(f.find((x) => x.kind === "SAME_AMOUNT_DAYS")?.distinctRefs).toBe(true);
  });

  it("cash flow: opening + in − out = closing, period boundaries respected, own-account moves net to zero", () => {
    const entries = [
      { date: "2026-08-01", type: "SALE", delta: 10000 },
      { date: "2026-09-02", type: "SALE", delta: 5000 },
      { date: "2026-09-03", type: "PAYOUT", delta: 0 }, // Stripe → bank within one entry
      { date: "2026-09-10", type: "ORGANISER_PAYMENT", delta: -4000 },
      { date: "2026-11-01", type: "SALE", delta: 999 },
    ];
    const f = cashFlow("gbp", entries, { from: "2026-09-01", to: "2026-09-30" });
    expect(f).toMatchObject({ opening: 10000, inflows: 5000, outflows: 4000, closing: 11000 });
    expect(f.byType.map((x) => x.type)).not.toContain("PAYOUT");
    expect(cashFlow("gbp", entries, {}).closing).toBe(entries.reduce((s, e) => s + e.delta, 0));
  });

  it("converts for indicative totals only when a rate exists", () => {
    expect(convertMinor(10000, "eur", "gbp", { eur: "0.85" })).toBe(8500);
    expect(convertMinor(10000, "gbp", "gbp", {})).toBe(10000);
    expect(convertMinor(10000, "sek", "gbp", {})).toBeNull();
  });
});

describe("financial position — from real ledger data", () => {
  let env: { orgId: string; organiserId: string; fake: FakeStripe; actor: { orgId: string; userId: string; ctx: ReturnType<typeof ctxFor> } };
  beforeAll(async () => {
    const { org, user } = await makeOrg("Position Test");
    const fake = new FakeStripe();
    setStripeGatewayFactory(() => fake);
    const [acc] = await db.insert(schema.stripeAccounts).values({ organisationId: org.id, livemode: false, secretKeyEnc: encrypt(`sk_test_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…pos1", status: "CONNECTED", stripeAccountId: "acct_1POSTEST" }).returning();
    const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    const organiser = await createOrganiser(actor, { name: "Gala Nights Ltd", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
    const event = await createEvent(actor, { name: "Gala Night", code: `GN-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "gbp", organiserId: organiser.id, startsOn: "2026-01-15", status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    const ctx = await importContext(acc as StripeAccountRow, fake);
    for (const amount of [10000, 20000]) await importBalanceTransaction(ctx, fake.sale({ amount, fee: 100, currency: "gbp", description: `Order for event: Gala Night (${event.code})` }).bt);
    env = { orgId: org.id, organiserId: organiser.id, fake, actor };
  });

  it("matches cash to the Stripe API, organiser debt to the settlement, and leaves the rest", async () => {
    const r = await financialPosition(env.orgId, "test", {});
    const gbp = r.positions.find((p) => p.currency === "gbp")!;
    // Stripe holds 300.00 − 2.00 fees; organiser is due 90 % of 300.00.
    expect(gbp).toMatchObject({ cash: 29800, organisersOwed: 27000, liabilities: 27000, remaining: 2800, shortfall: 0, status: "VERIFIED" });
    expect(r.settlements).toHaveLength(1);
    expect(r.settlements[0]).toMatchObject({ organiserName: "Gala Nights Ltd", due: 27000, paid: 0, remaining: 27000, dueNow: 27000, dueLater: 0, status: "NOT_SETTLED" });
    expect(r.reconciliation.find((x) => x.currency === "gbp")).toMatchObject({ stripeBooks: 29800, stripeReal: 29800 });
    expect(r.alerts.filter((a) => a.severity === "critical")).toEqual([]);
    expect(r.profit.find((p) => p.currency === "gbp")).toMatchObject({ revenue: 3000, netProfit: 2800 });
    expect(r.inventory.applicable).toBe(false);
  });

  it("a payment reduces the debt once; a duplicate is flagged; voiding it restores the figures", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const pay = (bankReference: string) => recordOrganiserPayment(env.actor, { mode: "test", organiserId: env.organiserId, eventId: null, amount: 10000, currency: "gbp", paymentDate: today, bankReference, method: "BANK_TRANSFER", notes: null, status: "PAID" });
    await pay("BANK-0001");
    const dup = await pay("BANK-0001");
    let r = await financialPosition(env.orgId, "test", {});
    expect(r.settlements[0]).toMatchObject({ paid: 20000, remaining: 7000 });
    expect(r.alerts.some((a) => a.title.startsWith("Possible duplicate payment") && a.severity === "critical")).toBe(true);
    await voidOrganiserPayment(env.actor, dup.id, "Recorded twice");
    r = await financialPosition(env.orgId, "test", {});
    expect(r.settlements[0]).toMatchObject({ paid: 10000, remaining: 17000 });
    expect(r.positions.find((p) => p.currency === "gbp")).toMatchObject({ organisersOwed: 17000 });
    expect(r.alerts.some((a) => a.title.startsWith("Possible duplicate payment"))).toBe(false);
    const [row] = await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.id, dup.id));
    expect(row?.status).toBe("VOIDED");
  });
});
