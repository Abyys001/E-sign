import type Stripe from "stripe";
import type { StripeGateway } from "@/server/accounting/stripe-gateway";

/**
 * Stripe API objects shaped exactly like the API returns them (only the fields the finance module reads), served by an
 * in-memory gateway. Used by tests only; production always talks to the real API through the official SDK.
 */
let seq = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36).padStart(4, "0")}TEST`;
const now = () => Math.floor(Date.now() / 1000);

export function chargeObj(o: { amount: number; currency?: string; description?: string | null; metadata?: Record<string, string>; livemode?: boolean; created?: number; status?: string; id?: string; pi?: string | null; amountRefunded?: number; name?: string; email?: string }): Stripe.Charge {
  return {
    id: o.id ?? nid("ch"), object: "charge", amount: o.amount, amount_captured: o.status === "failed" ? 0 : o.amount, amount_refunded: o.amountRefunded ?? 0, currency: o.currency ?? "eur", status: (o.status ?? "succeeded") as Stripe.Charge.Status,
    paid: o.status !== "failed", refunded: false, disputed: false, description: o.description ?? null, metadata: o.metadata ?? {}, livemode: o.livemode ?? false, created: o.created ?? now(),
    payment_intent: o.pi === undefined ? null : o.pi, balance_transaction: null, billing_details: { name: o.name ?? "Test Customer", email: o.email ?? "customer@example.test", address: null, phone: null, tax_id: null },
    customer: null, receipt_email: null, calculated_statement_descriptor: "BILIT", statement_descriptor: null, failure_code: o.status === "failed" ? "card_declined" : null, failure_message: o.status === "failed" ? "Your card was declined." : null,
  } as unknown as Stripe.Charge;
}

export function btObj(o: { type: string; amount: number; fee?: number; currency?: string; source: string | object | null; reportingCategory?: string; created?: number; description?: string | null; id?: string; exchangeRate?: number | null }): Stripe.BalanceTransaction {
  const fee = o.fee ?? 0;
  return {
    id: o.id ?? nid("txn"), object: "balance_transaction", type: o.type as Stripe.BalanceTransaction.Type, amount: o.amount, fee, net: o.amount - fee, currency: o.currency ?? "eur",
    reporting_category: o.reportingCategory ?? (o.type === "payment" ? "charge" : o.type), source: o.source as Stripe.BalanceTransaction["source"], created: o.created ?? now(), available_on: (o.created ?? now()) + 2 * 86400,
    status: "pending", description: o.description ?? null, exchange_rate: o.exchangeRate ?? null, balance_type: "payments",
    fee_details: fee ? [{ amount: fee, currency: o.currency ?? "eur", type: "stripe_fee", description: "Stripe processing fees", application: null }] : [],
  } as unknown as Stripe.BalanceTransaction;
}

export class FakeStripe implements StripeGateway {
  bts: Stripe.BalanceTransaction[] = [];
  charges = new Map<string, Stripe.Charge>();
  refunds = new Map<string, Stripe.Refund>();
  disputes = new Map<string, Stripe.Dispute>();
  payouts = new Map<string, Stripe.Payout>();
  intents = new Map<string, Stripe.PaymentIntent>();
  payoutBts = new Map<string, string[]>();
  calls: string[] = [];
  livemode = false;
  failOn = new Set<string>();

  /** A successful card payment: charge + its balance transaction (gross, Stripe fee, net). */
  sale(o: Parameters<typeof chargeObj>[0] & { fee: number }) {
    const c = chargeObj({ ...o, livemode: o.livemode ?? this.livemode });
    const bt = btObj({ type: "charge", amount: c.amount, fee: o.fee, currency: c.currency, source: c.id, created: c.created, description: c.description });
    (c as { balance_transaction: string }).balance_transaction = bt.id;
    this.charges.set(c.id, c); this.bts.push(bt);
    return { charge: c, bt };
  }
  refund(charge: Stripe.Charge, amount: number, fee = 0) {
    const r = { id: nid("re"), object: "refund", amount, currency: charge.currency, charge: charge.id, payment_intent: charge.payment_intent, status: "succeeded", reason: "requested_by_customer", created: now(), balance_transaction: null, failure_balance_transaction: null } as unknown as Stripe.Refund;
    const bt = btObj({ type: "refund", amount: -amount, fee, currency: charge.currency, source: r.id, reportingCategory: "refund" });
    (r as { balance_transaction: string }).balance_transaction = bt.id;
    this.refunds.set(r.id, r); this.bts.push(bt);
    const c = charge as { amount_refunded: number; refunded: boolean };
    c.amount_refunded += amount; c.refunded = c.amount_refunded >= charge.amount;
    return { refund: r, bt };
  }
  dispute(charge: Stripe.Charge, amount: number, disputeFee: number, status = "needs_response") {
    const d = { id: nid("du"), object: "dispute", amount, currency: charge.currency, charge: charge.id, reason: "fraudulent", status, created: now(), livemode: this.livemode, balance_transactions: [] as Stripe.BalanceTransaction[] } as unknown as Stripe.Dispute;
    const bt = btObj({ type: "adjustment", amount: -amount, fee: disputeFee, currency: charge.currency, source: d.id, reportingCategory: "dispute" });
    (d.balance_transactions as Stripe.BalanceTransaction[]).push(bt);
    this.disputes.set(d.id, d); this.bts.push(bt);
    return { dispute: d, bt };
  }
  payout(amount: number, includes: string[], status = "paid", currency = "eur") {
    const p = { id: nid("po"), object: "payout", amount, currency, status, automatic: true, method: "standard", arrival_date: now(), created: now(), livemode: this.livemode, description: "STRIPE PAYOUT", statement_descriptor: null, balance_transaction: null, failure_balance_transaction: null, failure_code: null, failure_message: null } as unknown as Stripe.Payout;
    const bt = btObj({ type: "payout", amount: -amount, currency, source: p.id, reportingCategory: "payout" });
    (p as { balance_transaction: string }).balance_transaction = bt.id;
    this.payouts.set(p.id, p); this.bts.push(bt);
    this.payoutBts.set(p.id, [...includes, bt.id]);
    return { payout: p, bt };
  }

  private find(id: string) { const b = this.bts.find((x) => x.id === id); if (!b) throw Object.assign(new Error(`No such balance transaction: ${id}`), { type: "StripeInvalidRequestError" }); return b; }
  private guard(name: string, id?: string) { this.calls.push(`${name}${id ? `:${id}` : ""}`); if (id && this.failOn.has(id)) throw new Error(`simulated Stripe failure for ${id}`); }
  async listBalanceTransactions(p: { createdGte?: number; createdLte?: number; startingAfter?: string; payout?: string; limit?: number }) {
    this.guard("listBalanceTransactions");
    let list = p.payout ? (this.payoutBts.get(p.payout) ?? []).map((id) => this.find(id)) : [...this.bts].reverse(); // Stripe lists newest first
    if (p.createdGte) list = list.filter((b) => b.created >= p.createdGte!);
    if (p.createdLte) list = list.filter((b) => b.created <= p.createdLte!);
    const start = p.startingAfter ? list.findIndex((b) => b.id === p.startingAfter) + 1 : 0;
    const limit = p.limit ?? 3; // small pages so pagination is exercised
    const page = list.slice(start, start + limit);
    return { data: page.map((b) => this.expand(b)), hasMore: start + limit < list.length };
  }
  private expand(b: Stripe.BalanceTransaction) {
    const src = typeof b.source === "string" ? b.source : null;
    // An object in failOn is returned unexpanded, so the importer has to fetch it — and that fetch fails.
    const obj = src && !this.failOn.has(src) ? this.charges.get(src) ?? this.refunds.get(src) ?? this.disputes.get(src) ?? this.payouts.get(src) : null;
    return { ...b, source: obj ?? b.source } as Stripe.BalanceTransaction;
  }
  async retrieveBalanceTransaction(id: string) { this.guard("retrieveBalanceTransaction", id); return this.expand(this.find(id)); }
  async retrieveCharge(id: string) { this.guard("retrieveCharge", id); const c = this.charges.get(id); if (!c) throw new Error(`No such charge: ${id}`); return c; }
  async retrievePaymentIntent(id: string) { this.guard("retrievePaymentIntent", id); const p = this.intents.get(id); if (!p) throw new Error(`No such payment_intent: ${id}`); return p; }
  async retrieveRefund(id: string) { this.guard("retrieveRefund", id); return this.refunds.get(id)!; }
  async retrieveDispute(id: string) { this.guard("retrieveDispute", id); return this.disputes.get(id)!; }
  async listRefundsForCharge(chargeId: string) { return [...this.refunds.values()].filter((r) => r.charge === chargeId); }
  async listPayouts(p: { createdGte?: number; createdLte?: number }) { return { data: [...this.payouts.values()].filter((x) => (!p.createdGte || x.created >= p.createdGte) && (!p.createdLte || x.created <= p.createdLte)), hasMore: false }; }
  async retrievePayout(id: string) { return this.payouts.get(id)!; }
  async retrieveBalance() {
    const by = new Map<string, number>();
    for (const b of this.bts) by.set(b.currency, (by.get(b.currency) ?? 0) + b.net);
    return { object: "balance", livemode: this.livemode, available: [...by].map(([currency, amount]) => ({ currency, amount, source_types: {} })), pending: [] } as unknown as Stripe.Balance;
  }
  async retrieveAccount() { return { id: "acct_1TESTBILIT", name: "Bilit Test" }; }
  async createWebhookEndpoint() { return { id: "we_test", secret: "whsec_testsecretvalue1234567890" }; }
}
