import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { encrypt } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { setStripeGatewayFactory, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { dashboard } from "@/server/accounting/reports";
import { listTransactions } from "@/server/accounting/queries";
import { dashboardSeries, dashboardStatus } from "@/server/accounting/command-centre";
import { ctxFor, makeOrg } from "./helpers";
import { FakeStripe } from "./stripe-fixtures";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeGatewayFactory(null); await stopBoss(); });

describe("finance dashboard data (command centre)", () => {
  let orgId = "";
  beforeAll(async () => {
    const { org, user } = await makeOrg("Command Centre Test");
    const fake = new FakeStripe();
    setStripeGatewayFactory(() => fake);
    const [acc] = await db.insert(schema.stripeAccounts).values({ organisationId: org.id, livemode: false, secretKeyEnc: encrypt(`sk_test_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…cc01", status: "CONNECTED", stripeAccountId: "acct_1CCTEST" }).returning();
    const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    const organiser = await createOrganiser(actor, { name: "Night Owl Ltd", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
    const event = await createEvent(actor, { name: "Owl Night", code: `ON-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "gbp", organiserId: organiser.id, startsOn: "2026-01-15", status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    const ctx = await importContext(acc as StripeAccountRow, fake);
    const s1 = fake.sale({ amount: 10000, fee: 170, currency: "gbp", description: `Order for event: Owl Night (${event.code})` });
    await importBalanceTransaction(ctx, s1.bt);
    await importBalanceTransaction(ctx, fake.sale({ amount: 4000, fee: 80, currency: "gbp", description: `Order for event: Owl Night (${event.code})` }).bt);
    await importBalanceTransaction(ctx, fake.refund(s1.charge, 2500).bt);
    await importBalanceTransaction(ctx, fake.sale({ amount: 999, fee: 30, currency: "gbp", description: "Order for event: Unknown (ZZ-0000)" }).bt);
    orgId = org.id;
  });

  it("the series adds up exactly to the dashboard totals for the same period, at every grouping", async () => {
    const d = await dashboard(orgId, "test", {});
    const gbp = d.currencies.find((c) => c.currency === "gbp")!;
    expect(gbp.grossSales).toBeGreaterThan(0);
    for (const grain of ["day", "week", "month", "year"] as const) {
      const s = (await dashboardSeries(orgId, "test", {}, grain)).filter((x) => x.currency === "gbp");
      const sum = (k: "grossSales" | "refunds" | "chargebacks" | "stripeFees" | "bilitProfit" | "net") => s.reduce((t, x) => t + x[k], 0);
      expect(sum("grossSales")).toBe(gbp.grossSales);
      expect(sum("refunds")).toBe(gbp.refunds);
      expect(sum("chargebacks")).toBe(gbp.chargebacks);
      expect(sum("stripeFees")).toBe(gbp.stripeFees);
      expect(sum("bilitProfit")).toBe(gbp.bilitProfit);
      expect(sum("net")).toBe(gbp.grossSales - gbp.refunds - gbp.chargebacks - gbp.stripeFees);
    }
  });

  it("status counts unmatched transactions and reports Stripe as connected, with no secrets", async () => {
    const s = await dashboardStatus(orgId, "test");
    expect(s.stripe.connected).toBe(true);
    expect(s.stripe.transactions).toBe(4);
    expect(s.review.unmatched).toBeGreaterThanOrEqual(1);
    expect(s.review.organisersOwed).toBe(1);
    expect(JSON.stringify(s)).not.toMatch(/sk_test_|secret/i);
  });

  it("transactions can be sorted by amount without changing the filtered set", async () => {
    const byDate = await listTransactions(orgId, "test", {}, { limit: 50, offset: 0 });
    const byAmount = await listTransactions(orgId, "test", { sort: "amount_desc" }, { limit: 50, offset: 0 });
    expect(byAmount.total).toBe(byDate.total);
    const amounts = byAmount.items.map((x) => x.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });
});
