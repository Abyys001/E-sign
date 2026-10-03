import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { acctAudit, isLive, type Mode } from "./core";
import type { RequestContext } from "../audit";

/** The Stripe API surface the finance module uses. Production wraps the official SDK; tests inject recorded objects. */
export interface StripeGateway {
  listBalanceTransactions(p: { createdGte?: number; createdLte?: number; startingAfter?: string; payout?: string; limit?: number }): Promise<{ data: Stripe.BalanceTransaction[]; hasMore: boolean }>;
  retrieveBalanceTransaction(id: string): Promise<Stripe.BalanceTransaction>;
  retrieveCharge(id: string): Promise<Stripe.Charge>;
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent>;
  retrieveRefund(id: string): Promise<Stripe.Refund>;
  retrieveDispute(id: string): Promise<Stripe.Dispute>;
  listRefundsForCharge(chargeId: string): Promise<Stripe.Refund[]>;
  listPayouts(p: { createdGte?: number; createdLte?: number; startingAfter?: string }): Promise<{ data: Stripe.Payout[]; hasMore: boolean }>;
  retrievePayout(id: string): Promise<Stripe.Payout>;
  retrieveBalance(): Promise<Stripe.Balance>;
  retrieveAccount(): Promise<{ id: string; name: string | null } | null>;
  createWebhookEndpoint(url: string, events: string[]): Promise<{ id: string; secret: string }>;
}

/** Webhook events the finance module subscribes to. Each one only triggers a re-fetch of the object from the API. */
export const STRIPE_WEBHOOK_EVENTS = [
  "payment_intent.succeeded", "payment_intent.payment_failed",
  "charge.succeeded", "charge.failed", "charge.updated", "charge.refunded", "charge.refund.updated",
  "refund.created", "refund.updated", "refund.failed",
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated",
  "payout.created", "payout.updated", "payout.paid", "payout.failed", "payout.canceled", "payout.reconciliation_completed",
  "balance.available",
] as const;

class SdkGateway implements StripeGateway {
  constructor(private s: Stripe) {}
  async listBalanceTransactions(p: Parameters<StripeGateway["listBalanceTransactions"]>[0]) {
    const r = await this.s.balanceTransactions.list({ limit: p.limit ?? 100, starting_after: p.startingAfter, payout: p.payout, expand: ["data.source"], ...(p.createdGte || p.createdLte ? { created: { gte: p.createdGte, lte: p.createdLte } } : {}) });
    return { data: r.data, hasMore: r.has_more };
  }
  retrieveBalanceTransaction(id: string) { return this.s.balanceTransactions.retrieve(id, { expand: ["source"] }); }
  retrieveCharge(id: string) { return this.s.charges.retrieve(id); }
  retrievePaymentIntent(id: string) { return this.s.paymentIntents.retrieve(id); }
  retrieveRefund(id: string) { return this.s.refunds.retrieve(id); }
  retrieveDispute(id: string) { return this.s.disputes.retrieve(id); }
  async listRefundsForCharge(chargeId: string) { const out: Stripe.Refund[] = []; for await (const r of this.s.refunds.list({ charge: chargeId, limit: 100 })) { out.push(r); if (out.length >= 1000) break; } return out; }
  async listPayouts(p: Parameters<StripeGateway["listPayouts"]>[0]) {
    const r = await this.s.payouts.list({ limit: 100, starting_after: p.startingAfter, ...(p.createdGte || p.createdLte ? { created: { gte: p.createdGte, lte: p.createdLte } } : {}) });
    return { data: r.data, hasMore: r.has_more };
  }
  retrievePayout(id: string) { return this.s.payouts.retrieve(id); }
  retrieveBalance() { return this.s.balance.retrieve(); }
  async retrieveAccount() {
    try { const a = await this.s.accounts.retrieveCurrent(); return { id: a.id, name: a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? null }; }
    catch (e) { if (e instanceof Stripe.errors.StripePermissionError) return null; throw e; } // restricted keys may not read the account
  }
  async createWebhookEndpoint(url: string, events: string[]) {
    const w = await this.s.webhookEndpoints.create({ url, enabled_events: events as Stripe.WebhookEndpointCreateParams.EnabledEvent[], description: "Bilit finance (accounting import)" });
    if (!w.secret) throw new Error("Stripe did not return a signing secret");
    return { id: w.id, secret: w.secret };
  }
}

type Factory = (secretKey: string) => StripeGateway;
const g = globalThis as unknown as { __stripeGatewayFactory?: Factory };
const defaultFactory: Factory = (key) => new SdkGateway(new Stripe(key, { maxNetworkRetries: 3, timeout: 30_000, appInfo: { name: "bilit-finance" } }));
/** Test seam only. */
export function setStripeGatewayFactory(f: Factory | null) { g.__stripeGatewayFactory = f ?? undefined; }

export type StripeAccountRow = typeof schema.stripeAccounts.$inferSelect;

export async function getStripeAccount(orgId: string, mode: Mode, tx: Tx | typeof db = db): Promise<StripeAccountRow | null> {
  const [a] = await tx.select().from(schema.stripeAccounts).where(and(eq(schema.stripeAccounts.organisationId, orgId), eq(schema.stripeAccounts.livemode, isLive(mode))));
  return a ?? null;
}

export function gatewayFor(a: StripeAccountRow): StripeGateway {
  if (!a.secretKeyEnc || a.status === "DISCONNECTED") throw new AppError("config_missing", `Stripe ${a.livemode ? "live" : "test"} mode is not connected.`);
  return (g.__stripeGatewayFactory ?? defaultFactory)(decrypt(a.secretKeyEnc));
}

/** Stripe errors are logged and stored as type/code/message only — never request bodies, headers or keys. */
export function safeStripeError(e: unknown): string {
  if (e instanceof Stripe.errors.StripeError) return `${e.type}${e.code ? `/${e.code}` : ""}: ${e.message}`.slice(0, 500);
  if (e instanceof AppError) return e.message;
  return (e instanceof Error ? e.message : String(e)).replace(/(sk|rk|whsec)_[A-Za-z0-9_]+/g, "$1_[redacted]").slice(0, 500);
}

const KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const hint = (k: string) => `${k.slice(0, 8)}…${k.slice(-4)}`;

/** Store (or replace) an API key for one mode after proving it works. The key is encrypted; only a hint is ever shown. */
export async function connectStripe(a: { orgId: string; userId: string; mode: Mode; secretKey: string; ctx: RequestContext }) {
  const key = a.secretKey.trim();
  const m = KEY_RE.exec(key);
  if (!m) throw new AppError("validation_failed", "That is not a Stripe secret (sk_…) or restricted (rk_…) API key.", [{ path: "secretKey", message: "Paste a key starting with rk_ or sk_." }]);
  if ((m[2] === "live") !== isLive(a.mode)) throw new AppError("validation_failed", `That is a ${m[2]} key; it cannot be used for ${a.mode} mode.`, [{ path: "secretKey", message: "Key mode does not match." }]);
  const gw = (g.__stripeGatewayFactory ?? defaultFactory)(key);
  let account: { id: string; name: string | null } | null;
  try { await gw.retrieveBalance(); account = await gw.retrieveAccount(); }
  catch (e) { throw new AppError("validation_failed", `Stripe rejected the key: ${safeStripeError(e)}`, [{ path: "secretKey", message: "Stripe rejected this key." }]); }
  return db.transaction(async (tx) => {
    const before = await getStripeAccount(a.orgId, a.mode, tx);
    const values = { secretKeyEnc: encrypt(key), keyHint: hint(key), status: "CONNECTED", stripeAccountId: account?.id ?? before?.stripeAccountId ?? null, displayName: account?.name ?? before?.displayName ?? null, lastTestedAt: new Date(), lastError: null, updatedAt: new Date() };
    const [row] = before
      ? await tx.update(schema.stripeAccounts).set(values).where(eq(schema.stripeAccounts.id, before.id)).returning()
      : await tx.insert(schema.stripeAccounts).values({ organisationId: a.orgId, livemode: isLive(a.mode), ...values }).returning();
    // Open the finance screens on the environment that actually has data when the other one is not connected.
    const other = await getStripeAccount(a.orgId, isLive(a.mode) ? "test" : "live", tx);
    if (!other?.secretKeyEnc) await tx.insert(schema.acctSettings).values({ organisationId: a.orgId, defaultMode: a.mode }).onConflictDoUpdate({ target: schema.acctSettings.organisationId, set: { defaultMode: a.mode } });
    await acctAudit(tx, { orgId: a.orgId, userId: a.userId, ctx: a.ctx, action: "stripe.connected", entity: "stripe_account", entityId: row!.id, old: before ? { keyHint: before.keyHint, status: before.status } : null, new: { keyHint: row!.keyHint, mode: a.mode, stripeAccountId: row!.stripeAccountId } });
    return row!;
  });
}

export async function setWebhookSecret(a: { orgId: string; userId: string; mode: Mode; secret: string; endpointId?: string; ctx: RequestContext }) {
  const s = a.secret.trim();
  if (!/^whsec_[A-Za-z0-9+/=_-]{10,}$/.test(s)) throw new AppError("validation_failed", "A webhook signing secret starts with whsec_.", [{ path: "secret", message: "Paste the whsec_… signing secret." }]);
  return db.transaction(async (tx) => {
    const acc = await getStripeAccount(a.orgId, a.mode, tx);
    if (!acc) throw new AppError("invalid_state", "Connect the Stripe API key for this mode first.");
    await tx.update(schema.stripeAccounts).set({ webhookSecretEnc: encrypt(s), webhookSecretHint: `whsec_…${s.slice(-4)}`, webhookEndpointId: a.endpointId ?? acc.webhookEndpointId, updatedAt: new Date() }).where(eq(schema.stripeAccounts.id, acc.id));
    await acctAudit(tx, { orgId: a.orgId, userId: a.userId, ctx: a.ctx, action: "stripe.webhook_secret_set", entity: "stripe_account", entityId: acc.id, old: { hint: acc.webhookSecretHint }, new: { hint: `whsec_…${s.slice(-4)}` } });
  });
}

/** Re-test stored credentials and record the outcome (status + safe error) on the account row. */
export async function testStripe(orgId: string, mode: Mode) {
  const acc = await getStripeAccount(orgId, mode);
  if (!acc?.secretKeyEnc) throw new AppError("invalid_state", `Stripe ${mode} mode is not connected.`);
  try {
    const gw = gatewayFor(acc);
    const bal = await gw.retrieveBalance();
    const account = await gw.retrieveAccount();
    await db.update(schema.stripeAccounts).set({ status: "CONNECTED", lastTestedAt: new Date(), lastError: null, stripeAccountId: account?.id ?? acc.stripeAccountId, displayName: account?.name ?? acc.displayName, updatedAt: new Date() }).where(eq(schema.stripeAccounts.id, acc.id));
    if (bal.livemode !== acc.livemode) throw new AppError("invalid_state", "Stripe returned data for the other mode; check the key.");
    return { ok: true as const, livemode: bal.livemode, accountId: account?.id ?? acc.stripeAccountId };
  } catch (e) {
    const msg = safeStripeError(e);
    log.warn("stripe.test_failed", { orgId, mode, error: msg });
    await db.update(schema.stripeAccounts).set({ status: "ERROR", lastTestedAt: new Date(), lastError: msg, updatedAt: new Date() }).where(eq(schema.stripeAccounts.id, acc.id));
    return { ok: false as const, error: msg };
  }
}

export async function disconnectStripe(a: { orgId: string; userId: string; mode: Mode; ctx: RequestContext }) {
  return db.transaction(async (tx) => {
    const acc = await getStripeAccount(a.orgId, a.mode, tx);
    if (!acc) return;
    // Imported data stays; only the credentials are destroyed.
    await tx.update(schema.stripeAccounts).set({ secretKeyEnc: null, webhookSecretEnc: null, status: "DISCONNECTED", updatedAt: new Date() }).where(eq(schema.stripeAccounts.id, acc.id));
    await acctAudit(tx, { orgId: a.orgId, userId: a.userId, ctx: a.ctx, action: "stripe.disconnected", entity: "stripe_account", entityId: acc.id, old: { keyHint: acc.keyHint }, new: null });
  });
}

/** Public, secret-free view of a Stripe connection. */
export function stripeAccountView(a: StripeAccountRow | null, mode: Mode) {
  if (!a) return { mode, connected: false, status: "DISCONNECTED" };
  return {
    mode, connected: a.status !== "DISCONNECTED" && !!a.secretKeyEnc, status: a.status, stripeAccountId: a.stripeAccountId, displayName: a.displayName, keyHint: a.keyHint,
    webhookConfigured: !!a.webhookSecretEnc, webhookSecretHint: a.webhookSecretHint, webhookEndpointId: a.webhookEndpointId,
    lastTestedAt: a.lastTestedAt, lastError: a.lastError, lastSyncAt: a.lastSyncAt, lastWebhookAt: a.lastWebhookAt, lastWebhookType: a.lastWebhookType,
  };
}
