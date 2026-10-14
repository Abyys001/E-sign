import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { encrypt } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { setStripeGatewayFactory, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { organiserBalances } from "@/server/accounting/finance";
import { parseFinancialAccount, payoutMethodLabel, preparePayout, sendPayout, setStripeV2, StripeV2Error, syncPayouts, updatePayoutSettings } from "@/server/accounting/stripe-payouts";
import { ctxFor, makeOrg } from "./helpers";
import { FakeStripe } from "./stripe-fixtures";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeV2(null); setStripeGatewayFactory(null); await stopBoss(); });

describe("stripe payouts — pure helpers", () => {
  it("reads available balances per currency from a v2 financial account", () => {
    expect(parseFinancialAccount({ id: "fa_1", display_name: "Main", balance: { available: { gbp: { value: 12345, currency: "gbp" }, eur: { value: "500", currency: "eur" } } } }))
      .toEqual({ id: "fa_1", name: "Main", balances: { gbp: 12345, eur: 500 } });
    expect(parseFinancialAccount({ id: "fa_2" }).balances).toEqual({});
  });
  it("labels payout methods", () => {
    expect(payoutMethodLabel({ type: "bank_account", bank_account: { bank_name: "Barclays", last4: "1234", country: "gb" } })).toBe("Barclays ••1234 (GB)");
    expect(payoutMethodLabel({ type: "card", card: { brand: "visa", last4: "4242" } })).toBe("visa ••4242");
  });
});

/** A recorded stand-in for Stripe's v2 money-management API. */
class FakeV2 {
  calls: Array<{ method: string; path: string; body?: unknown; idem?: string; context?: string }> = [];
  balance = 100000;
  obpStatus = "processing";
  failNextCreate: "network" | "refuse" | null = null;
  created = new Map<string, Record<string, unknown>>(); // idempotency key → obp
  handler = async (_key: string, method: "GET" | "POST", path: string, o: { body?: unknown; context?: string; idempotencyKey?: string } = {}): Promise<Record<string, unknown>> => {
    this.calls.push({ method, path, body: o.body, idem: o.idempotencyKey, context: o.context });
    const fa = { id: "fa_test1", display_name: "Bilit GBP", status: "open", balance: { available: { gbp: { value: this.balance, currency: "gbp" } } } };
    if (path.startsWith("/v2/money_management/financial_accounts?")) return { data: [fa] };
    if (path.startsWith("/v2/money_management/financial_accounts/")) return fa;
    if (path.startsWith("/v2/money_management/payout_methods")) return { data: [{ id: "gbba_1", type: "bank_account", bank_account: { bank_name: "Monzo", last4: "9876", country: "GB" } }] };
    if (path === "/v2/money_management/outbound_payment_quotes") return { id: "obpq_1", estimated_fees: [{ type: "standard_payout_fee", amount: { value: 30, currency: "gbp" } }], to: { credited: { value: (o.body as { amount: { value: number } }).amount.value, currency: "gbp" } } };
    if (path.startsWith("/v2/money_management/outbound_payment_quotes/")) return { id: "obpq_1", estimated_fees: [{ type: "standard_payout_fee", amount: { value: 30, currency: "gbp" } }] };
    if (path === "/v2/money_management/recipient_verifications") return { id: "rv_1", match_result: "close_match", match_result_details: { matched_name: "GALA NIGHTS LIMITED", message: "Close match" }, status: "awaiting_acknowledgement" };
    if (path.startsWith("/v2/money_management/recipient_verifications/rv_1/acknowledge")) return { id: "rv_1", status: "acknowledged" };
    if (path.startsWith("/v2/money_management/recipient_verifications/")) return { id: "rv_1", match_result: "close_match", status: "awaiting_acknowledgement" };
    if (path === "/v2/money_management/outbound_payments" && method === "POST") {
      if (this.failNextCreate === "network") { this.failNextCreate = null; throw new StripeV2Error("Stripe did not answer (TimeoutError).", 0, null, true); }
      if (this.failNextCreate === "refuse") { this.failNextCreate = null; throw new StripeV2Error("Stripe: Recipient is not active.", 400, "invalid_recipient", false); }
      const existing = this.created.get(o.idempotencyKey!);
      if (existing) return existing;
      const obp = { id: `obp_${randomBytes(4).toString("hex")}`, status: "processing", ...(o.body as object) };
      this.created.set(o.idempotencyKey!, obp);
      this.balance -= (o.body as { amount: { value: number } }).amount.value;
      return obp;
    }
    if (path.startsWith("/v2/money_management/outbound_payments/")) {
      const id = path.split("/").pop()!;
      const obp = [...this.created.values()].find((x) => x.id === id)!;
      return { ...obp, status: this.obpStatus, ...(this.obpStatus === "returned" ? { status_details: { returned: { reason: "recipient_account_closed" } } } : {}) };
    }
    throw new StripeV2Error(`unexpected ${method} ${path}`, 404, null, false);
  };
}

describe("stripe payouts — send, book, follow status", () => {
  let env: { orgId: string; organiserId: string; actor: { orgId: string; userId: string; ctx: ReturnType<typeof ctxFor> } };
  let v2: FakeV2;
  beforeAll(async () => {
    const { org, user } = await makeOrg("Payouts Test");
    const fake = new FakeStripe();
    setStripeGatewayFactory(() => fake);
    const [acc] = await db.insert(schema.stripeAccounts).values({ organisationId: org.id, livemode: false, secretKeyEnc: encrypt(`sk_test_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…pay1", status: "CONNECTED", stripeAccountId: "acct_1PAYTEST" }).returning();
    const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    const organiser = await createOrganiser(actor, { name: "Gala Nights Ltd", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
    const event = await createEvent(actor, { name: "Gala Night", code: `GP-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "gbp", organiserId: organiser.id, startsOn: "2026-01-15", status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    const ctx = await importContext(acc as StripeAccountRow, fake);
    for (const amount of [10000, 20000]) await importBalanceTransaction(ctx, fake.sale({ amount, fee: 100, currency: "gbp", description: `Order for event: Gala Night (${event.code})` }).bt);
    env = { orgId: org.id, organiserId: organiser.id, actor };
    v2 = new FakeV2(); setStripeV2(v2.handler);
    await updatePayoutSettings(actor, { mode: "test", apiKey: `rk_test_${randomBytes(12).toString("hex")}` });
  });
  beforeEach(() => { v2.obpStatus = "processing"; });

  const owed = async () => (await organiserBalances(env.orgId, "test")).find((b) => b.organiserId === env.organiserId && b.currency === "gbp")!.remaining;
  const input = (amount: number) => ({ mode: "test" as const, payeeType: "ORGANISER" as const, payeeId: env.organiserId, amount, currency: "gbp", recipientId: "acct_1RECIP", payoutMethodId: "gbba_1" });

  it("refuses a full sk_live key and keys for the other mode", async () => {
    await expect(updatePayoutSettings(env.actor, { mode: "live", apiKey: `sk_live_${randomBytes(12).toString("hex")}` })).rejects.toThrow(/restricted key/);
    await expect(updatePayoutSettings(env.actor, { mode: "live", apiKey: `rk_test_${randomBytes(12).toString("hex")}` })).rejects.toThrow(/test key/);
  });

  it("prepare: checks the balance owed, gives Stripe's quote and the name check; moves nothing", async () => {
    expect(await owed()).toBe(27000);
    const p = await preparePayout(env.orgId, input(5000));
    expect(p).toMatchObject({ payee: { name: "Gala Nights Ltd", owed: 27000 }, available: 100000, quote: { id: "obpq_1", feeTotal: 30 }, verification: { id: "rv_1", result: "close_match", matchedName: "GALA NIGHTS LIMITED" } });
    expect(v2.calls.some((c) => c.path === "/v2/money_management/outbound_payments")).toBe(false);
    await expect(preparePayout(env.orgId, input(30000))).rejects.toThrow(/more than the GBP balance owed/);
  });

  it("send: a name-check mismatch must be acknowledged; then pays, books an organiser payment with the obp reference", async () => {
    await expect(sendPayout(env.actor, { ...input(5000), quoteId: "obpq_1", verificationId: "rv_1", acknowledgeMismatch: false })).rejects.toThrow(/name check/);
    const r = await sendPayout(env.actor, { ...input(5000), quoteId: "obpq_1", verificationId: "rv_1", acknowledgeMismatch: true });
    expect(r).toMatchObject({ status: "PROCESSING", feeAmount: 30, payoutMethodLabel: "Monzo ••9876 (GB)" });
    expect(r.stripeId).toMatch(/^obp_/);
    const create = v2.calls.find((c) => c.path === "/v2/money_management/outbound_payments" && c.method === "POST")!;
    expect(create.idem).toBe(`bilit-obp-${r.id}`);
    expect(create.body).toMatchObject({ from: { financial_account: "fa_test1", currency: "gbp" }, to: { recipient: "acct_1RECIP", payout_method: "gbba_1" }, amount: { value: 5000, currency: "gbp" }, outbound_payment_quote: "obpq_1", recipient_verification: "rv_1" });
    const [pay] = await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.id, r.organiserPaymentId!));
    expect(pay).toMatchObject({ amount: 5000, currency: "gbp", method: "STRIPE_TRANSFER", bankReference: r.stripeId, status: "PAID" });
    expect(await owed()).toBe(22000);
  });

  it("blocks the same amount to the same payee within 3 days unless confirmed", async () => {
    await expect(preparePayout(env.orgId, input(5000))).rejects.toThrow(/same amount/);
    await expect(preparePayout(env.orgId, { ...input(5000), allowDuplicate: true })).resolves.toBeTruthy();
  });

  it("a returned payment is un-booked automatically (organiser payment voided, balance owed restored)", async () => {
    v2.obpStatus = "returned";
    await syncPayouts(env.orgId, "test");
    const [row] = await db.select().from(schema.acctStripeOutbound).where(eq(schema.acctStripeOutbound.organisationId, env.orgId));
    expect(row).toMatchObject({ status: "RETURNED", failure: "recipient account closed" });
    const [pay] = await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.id, row!.organiserPaymentId!));
    expect(pay!.status).toBe("VOIDED");
    expect(await owed()).toBe(27000);
  });

  it("no answer from Stripe: stays SENDING, the sync retries with the SAME idempotency key and books exactly once", async () => {
    v2.failNextCreate = "network";
    await expect(sendPayout(env.actor, { ...input(7000), quoteId: null, verificationId: null, acknowledgeMismatch: false })).rejects.toThrow(/Do NOT send it again/);
    const sending = (await db.select().from(schema.acctStripeOutbound).where(eq(schema.acctStripeOutbound.organisationId, env.orgId))).find((x) => x.amount === 7000)!;
    expect(sending.status).toBe("SENDING");
    expect(await owed()).toBe(27000);
    await syncPayouts(env.orgId, "test");
    await syncPayouts(env.orgId, "test");
    const after = (await db.select().from(schema.acctStripeOutbound).where(eq(schema.acctStripeOutbound.id, sending.id)))[0]!;
    expect(after.status).toBe("PROCESSING");
    expect([...v2.created.keys()].filter((k) => k === `bilit-obp-${sending.id}`)).toHaveLength(1);
    const pays = await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.bankReference, after.stripeId!));
    expect(pays).toHaveLength(1);
    expect(await owed()).toBe(20000);
  });

  it("a refusal from Stripe books nothing", async () => {
    v2.failNextCreate = "refuse";
    await expect(sendPayout(env.actor, { ...input(1000), quoteId: null, verificationId: null, acknowledgeMismatch: false })).rejects.toThrow(/not active/);
    const rej = (await db.select().from(schema.acctStripeOutbound).where(eq(schema.acctStripeOutbound.organisationId, env.orgId))).find((x) => x.amount === 1000)!;
    expect(rej).toMatchObject({ status: "REJECTED", organiserPaymentId: null });
    expect(await owed()).toBe(20000);
  });

  it("refuses when the financial account does not hold enough", async () => {
    v2.balance = 500;
    await expect(preparePayout(env.orgId, input(1000))).rejects.toThrow(/Not enough GBP/);
  });
});
