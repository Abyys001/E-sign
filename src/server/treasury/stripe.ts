import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt } from "../crypto";
import { AppError } from "../errors";
import { getAcctSettings, isLive, type Mode } from "../accounting/core";

/**
 * Stripe Treasury + Issuing, used only on the server. Admins create Issuing cards funded by a Treasury financial
 * account; the gateway also reads cardholders, cards, authorizations and transactions and flips card status for a
 * freeze. The key is a dedicated restricted key stored encrypted per mode, separate from the accounting/payouts keys,
 * and never reaches the browser. Capability detection decides what the UI may offer — unsupported features are hidden,
 * never faked.
 */
// API version: the SDK default (pinned by the installed stripe package).
type Conn = { keyEnc?: string | null; keyHint?: string | null; financialAccountId?: string | null; capabilities?: Capabilities | null; lastTestedAt?: string | null; lastError?: string | null };
type Stored = Partial<Record<Mode, Conn>>;
export type Capabilities = { issuing: boolean; treasury: boolean; financialAccounts: Array<{ id: string; status: string; currency: string | null; balance: number | null }> };

export interface TreasuryGateway {
  capabilities(): Promise<Capabilities>;
  createCardholder(i: { name: string; email?: string | null; phoneNumber?: string | null; type: "individual" | "company"; billing: Stripe.Issuing.CardholderCreateParams.Billing }): Promise<Stripe.Issuing.Cardholder>;
  listCardholders(): Promise<Stripe.Issuing.Cardholder[]>;
  createCard(i: { cardholder: string; currency: string; financialAccount?: string | null; type: "virtual" | "physical"; spendingControls?: Stripe.Issuing.CardCreateParams.SpendingControls }, idempotencyKey: string): Promise<Stripe.Issuing.Card>;
  retrieveCard(id: string): Promise<Stripe.Issuing.Card>;
  listCards(): Promise<Stripe.Issuing.Card[]>;
  setCardStatus(id: string, status: "active" | "inactive" | "canceled"): Promise<Stripe.Issuing.Card>;
  setSpendingControls(id: string, controls: Stripe.Issuing.CardUpdateParams.SpendingControls): Promise<Stripe.Issuing.Card>;
  /** Newest first. `since` (unix seconds) limits the list to objects created at or after it. */
  listAuthorizations(cardId: string, limit: number, since?: number): Promise<Stripe.Issuing.Authorization[]>;
  listTransactions(cardId: string, limit: number, since?: number): Promise<Stripe.Issuing.Transaction[]>;
  /** Every posted transaction on the card in [from, to] (unix seconds), paginated; capped at 5,000. */
  transactionsBetween(cardId: string, from: number, to: number): Promise<Stripe.Issuing.Transaction[]>;
  retrieveAuthorization(id: string): Promise<Stripe.Issuing.Authorization>;
  retrieveTransaction(id: string): Promise<Stripe.Issuing.Transaction>;
  constructEvent(raw: string, signature: string | null, secret: string): Stripe.Event;
}

class SdkGateway implements TreasuryGateway {
  constructor(private s: Stripe, private financialAccountId: string | null) {}
  async capabilities(): Promise<Capabilities> {
    let issuing = false, treasury = false;
    const financialAccounts: Capabilities["financialAccounts"] = [];
    try { await this.s.issuing.cardholders.list({ limit: 1 }); issuing = true; }
    catch (e) { if (!(e instanceof Stripe.errors.StripePermissionError || e instanceof Stripe.errors.StripeInvalidRequestError)) throw e; }
    try {
      const fas = await this.s.treasury.financialAccounts.list({ limit: 20 });
      treasury = true;
      for (const f of fas.data) {
        const bal = f.balance?.cash ?? {};
        const cur = Object.keys(bal)[0] ?? null;
        financialAccounts.push({ id: f.id, status: f.status, currency: cur, balance: cur ? (bal[cur] ?? null) : null });
      }
    } catch (e) { if (!(e instanceof Stripe.errors.StripePermissionError || e instanceof Stripe.errors.StripeInvalidRequestError)) throw e; }
    return { issuing, treasury, financialAccounts };
  }
  createCardholder(i: Parameters<TreasuryGateway["createCardholder"]>[0]) {
    return this.s.issuing.cardholders.create({ name: i.name, email: i.email ?? undefined, phone_number: i.phoneNumber ?? undefined, type: i.type, billing: i.billing });
  }
  async listCardholders() { const out: Stripe.Issuing.Cardholder[] = []; for await (const c of this.s.issuing.cardholders.list({ limit: 100 })) { out.push(c); if (out.length >= 500) break; } return out; }
  createCard(i: Parameters<TreasuryGateway["createCard"]>[0], idempotencyKey: string) {
    const fa = i.financialAccount ?? this.financialAccountId;
    return this.s.issuing.cards.create({
      cardholder: i.cardholder, currency: i.currency, type: i.type, status: "active",
      spending_controls: i.spendingControls,
      ...(fa ? { financial_account: fa } : {}),
    } as Stripe.Issuing.CardCreateParams, { idempotencyKey });
  }
  retrieveCard(id: string) { return this.s.issuing.cards.retrieve(id); }
  async listCards() { const out: Stripe.Issuing.Card[] = []; for await (const c of this.s.issuing.cards.list({ limit: 100 })) { out.push(c); if (out.length >= 500) break; } return out; }
  setCardStatus(id: string, status: "active" | "inactive" | "canceled") { return this.s.issuing.cards.update(id, { status }); }
  setSpendingControls(id: string, controls: Stripe.Issuing.CardUpdateParams.SpendingControls) { return this.s.issuing.cards.update(id, { spending_controls: controls }); }
  async listAuthorizations(cardId: string, limit: number, since?: number) { const r = await this.s.issuing.authorizations.list({ card: cardId, limit, ...(since ? { created: { gte: since } } : {}) }); return r.data; }
  async listTransactions(cardId: string, limit: number, since?: number) { const r = await this.s.issuing.transactions.list({ card: cardId, limit, ...(since ? { created: { gte: since } } : {}) }); return r.data; }
  async transactionsBetween(cardId: string, from: number, to: number) {
    const out: Stripe.Issuing.Transaction[] = [];
    for await (const t of this.s.issuing.transactions.list({ card: cardId, limit: 100, created: { gte: from, lte: to } })) { out.push(t); if (out.length >= 5000) break; }
    return out;
  }
  retrieveAuthorization(id: string) { return this.s.issuing.authorizations.retrieve(id); }
  retrieveTransaction(id: string) { return this.s.issuing.transactions.retrieve(id); }
  constructEvent(raw: string, signature: string | null, secret: string) {
    if (!signature) throw new AppError("validation_failed", "Missing Stripe signature.");
    return this.s.webhooks.constructEvent(raw, signature, secret);
  }
}

type Factory = (key: string, financialAccountId: string | null) => TreasuryGateway;
const g = globalThis as unknown as { __treasuryGatewayFactory?: Factory };
const defaultFactory: Factory = (key, fa) => new SdkGateway(new Stripe(key, { maxNetworkRetries: 2, timeout: 30_000, appInfo: { name: "bilit-treasury" } }), fa);
/** Test seam only. */
export function setTreasuryGateway(f: Factory | null) { g.__treasuryGatewayFactory = f ?? undefined; }

export function safeStripeError(e: unknown): string {
  if (e instanceof Stripe.errors.StripeError) return `${e.type}${e.code ? `/${e.code}` : ""}: ${e.message}`.replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g, "$1_[redacted]").slice(0, 400);
  return (e instanceof Error ? e.message : String(e)).replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g, "$1_[redacted]").slice(0, 400);
}

// ---------- settings / connection ----------
async function stored(orgId: string): Promise<Stored> {
  await getAcctSettings(orgId);
  const [s] = await db.select({ v: schema.acctSettings.treasurySettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  return (s?.v ?? {}) as Stored;
}
const saveStored = (orgId: string, v: Stored) => db.update(schema.acctSettings).set({ treasurySettings: v }).where(eq(schema.acctSettings.organisationId, orgId));

export async function treasuryConn(orgId: string, mode: Mode): Promise<{ key: string; financialAccountId: string | null; conn: Conn }> {
  const c = (await stored(orgId))[mode];
  if (!c?.keyEnc) throw new AppError("config_missing", `Stripe Treasury is not set up for ${mode} mode. Add a key in Finance settings → Treasury cards.`);
  return { key: decrypt(c.keyEnc), financialAccountId: c.financialAccountId ?? null, conn: c };
}
export async function treasuryGateway(orgId: string, mode: Mode): Promise<TreasuryGateway> {
  const { key, financialAccountId } = await treasuryConn(orgId, mode);
  return (g.__treasuryGatewayFactory ?? defaultFactory)(key, financialAccountId);
}
export async function treasuryWebhookSecret(orgId: string, mode: Mode): Promise<string | null> {
  const c = (await stored(orgId))[mode];
  return c && "webhookSecretEnc" in c && typeof (c as { webhookSecretEnc?: string }).webhookSecretEnc === "string" ? decrypt((c as { webhookSecretEnc: string }).webhookSecretEnc) : null;
}

export { stored as treasuryStored, saveStored as saveTreasuryStored, type Conn as TreasuryConn, type Stored as TreasuryStored };
export const isLiveMode = isLive;
