import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { payBill, unpayBill } from "./books";
import { acctAudit, accountingEnabled, Currency, getAcctSettings, isLive, localDate, ModeSchema, type Mode } from "./core";
import { organiserBalances } from "./finance";
import { recordOrganiserPayment, voidOrganiserPayment } from "./manual";
import { partnerOverview, recordPartnerPayment, voidPartnerPayment } from "./profit-share";

/**
 * "Send money": pay organisers, profit-share partners and supplier invoices from Bilit's Stripe financial account with
 * Stripe Global Payouts (OutboundPayments v2, preview API). Recipients (and their bank details) are created and verified
 * at Stripe — in the Dashboard (Treasury → Payouts → Recipients) — and only linked here by id.
 *
 * Flow: prepare (checks + Stripe quote + payee-name check) → send (admin, re-authenticated) → the book entry is created
 * as soon as Stripe accepts the payment (organiser payment / partner payment / bill paid, reference = obp id) and voided
 * automatically if Stripe later reports it failed, returned or cancelled. Every request to create money movement carries
 * an idempotency key derived from our row id, so a retry can never send twice.
 *
 * Stripe requires a RESTRICTED key for live Global Payouts (full sk_live keys are refused), with: Recipient configuration
 * write, Money Management financial accounts read, payout methods write, outbound payments write, recipient
 * verifications write. It is stored encrypted, separately from the read-only import key.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
type FinancialAccount = { id: string; name: string | null; balances: Record<string, number> };
type Conn = { keyEnc?: string | null; keyHint?: string | null; financialAccountId?: string | null; financialAccounts?: FinancialAccount[]; lastTestedAt?: string | null; lastError?: string | null };
type Stored = Partial<Record<Mode, Conn>>;

export const STRIPE_V2_VERSION = "2026-09-30.preview";
const SYSTEM_CTX: RequestContext = { userAgent: "bilit-finance-worker" };

// ---------- Stripe v2 transport ----------
/** A refusal Stripe answered (4xx): nothing was moved. `unknown` = no answer / 5xx: the outcome must be re-checked. */
export class StripeV2Error extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly unknown: boolean) { super(message); }
}
type V2Call = (key: string, method: "GET" | "POST", path: string, opts?: { body?: unknown; context?: string; idempotencyKey?: string }) => Promise<Record<string, unknown>>;

const v2Fetch: V2Call = async (key, method, path, opts = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_V2_VERSION, accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.context) headers["stripe-context"] = opts.context;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let res: Response;
  try { res = await fetch(`https://api.stripe.com${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw new StripeV2Error(`Stripe did not answer (${e instanceof Error ? e.name : "network error"}).`, 0, null, true); }
  const j = await res.json().catch(() => null) as { error?: { message?: string; code?: string; type?: string } } & Record<string, unknown> | null;
  if (!res.ok) {
    const msg = j?.error?.message ?? `HTTP ${res.status}`;
    throw new StripeV2Error(`Stripe: ${msg}`.replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g, "$1_[redacted]").slice(0, 500), res.status, j?.error?.code ?? j?.error?.type ?? null, res.status >= 500 || res.status === 429);
  }
  return j ?? {};
};
const g = globalThis as { __stripeV2?: V2Call };
/** Test seam only. */
export const setStripeV2 = (f: V2Call | null) => { g.__stripeV2 = f ?? undefined; };
const v2: V2Call = (...a) => (g.__stripeV2 ?? v2Fetch)(...a);

const asAppError = (e: unknown, path?: string) => {
  if (e instanceof StripeV2Error) {
    if (e.status === 401) return new AppError("validation_failed", "Stripe rejected the payouts key.", [{ path: "apiKey", message: "Check the restricted key" }]);
    if (e.status === 403) return new AppError("invalid_state", `${e.message} — the payouts key is missing a permission, or Global Payouts is not enabled on this Stripe account.`);
    return new AppError(e.unknown ? "invalid_state" : "validation_failed", e.message, path ? [{ path, message: e.message }] : undefined);
  }
  return e;
};

// ---------- settings ----------
async function stored(orgId: string): Promise<Stored> {
  await getAcctSettings(orgId);
  const [s] = await db.select({ v: schema.acctSettings.payoutSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  return (s?.v ?? {}) as Stored;
}
const saveStored = (orgId: string, v: Stored) => db.update(schema.acctSettings).set({ payoutSettings: v }).where(eq(schema.acctSettings.organisationId, orgId));

async function conn(orgId: string, mode: Mode) {
  const c = (await stored(orgId))[mode];
  if (!c?.keyEnc) throw new AppError("config_missing", `Stripe payouts are not set up for ${mode} mode. Add a payouts key in Finance settings → Stripe payouts.`);
  if (!c.financialAccountId) throw new AppError("config_missing", "Choose the Stripe financial account to pay from in Finance settings → Stripe payouts.");
  return { key: decrypt(c.keyEnc), financialAccountId: c.financialAccountId, c };
}

/** v2 money objects are { value, currency } with value in minor units (number or numeric string). */
const minor = (m: unknown): number => { const v = (m as { value?: unknown } | null)?.value; const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0; return Number.isSafeInteger(n) ? n : 0; };

/** Pure: a v2 FinancialAccount → id, name and available balance per currency. Unit-tested. */
export function parseFinancialAccount(fa: Record<string, unknown>): FinancialAccount {
  const avail = ((fa.balance as { available?: Record<string, unknown> } | undefined)?.available ?? {}) as Record<string, unknown>;
  const balances: Record<string, number> = {};
  for (const [k, v] of Object.entries(avail)) balances[((v as { currency?: string })?.currency ?? k).toLowerCase()] = minor(v);
  return { id: String(fa.id), name: (fa.display_name as string | undefined) ?? (fa.description as string | undefined) ?? null, balances };
}

async function fetchFinancialAccounts(key: string): Promise<FinancialAccount[]> {
  const r = await v2(key, "GET", "/v2/money_management/financial_accounts?limit=20");
  return ((r.data as Array<Record<string, unknown>> | undefined) ?? []).filter((f) => (f.status ?? "open") === "open").map(parseFinancialAccount);
}

export async function getPayoutSettings(orgId: string, mode: Mode) {
  const c = (await stored(orgId))[mode] ?? {};
  return { mode, connected: !!c.keyEnc, keyHint: c.keyHint ?? null, financialAccountId: c.financialAccountId ?? null, financialAccounts: c.financialAccounts ?? [], lastTestedAt: c.lastTestedAt ?? null, lastError: c.lastError ?? null, apiVersion: STRIPE_V2_VERSION };
}

export const PayoutSettingsInput = z.object({
  mode: ModeSchema,
  apiKey: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s/g, "") : v), z.string().regex(/^(rk|sk)_(test|live)_[A-Za-z0-9]{10,}$/, "Paste the restricted key exactly as Stripe shows it (rk_live_…)").optional().nullable()),
  financialAccountId: z.string().trim().regex(/^fa_[A-Za-z0-9_]+$/).optional().nullable(),
});

/** Save / replace / remove the payouts key and the source financial account; every save re-tests the key against Stripe. */
export async function updatePayoutSettings(a: Actor, input: z.infer<typeof PayoutSettingsInput>) {
  const all = await stored(a.orgId);
  const prev = all[input.mode] ?? {};
  const next: Conn = { ...prev };
  if (input.apiKey === null) { all[input.mode] = {}; await saveStored(a.orgId, all); await db.transaction((tx) => acctAudit(tx, { ...a, action: "payouts.key_removed", extra: { mode: input.mode } })); return getPayoutSettings(a.orgId, input.mode); }
  if (input.apiKey) {
    const live = input.apiKey.includes("_live_");
    if (live !== (input.mode === "live")) throw new AppError("validation_failed", `That is a ${live ? "live" : "test"} key; you are in ${input.mode} mode.`, [{ path: "apiKey", message: "Wrong mode" }]);
    if (input.apiKey.startsWith("sk_live_")) throw new AppError("validation_failed", "Stripe refuses full secret keys for live Global Payouts. Create a restricted key (rk_live_…) with the payout permissions.", [{ path: "apiKey", message: "Use a restricted key" }]);
    next.keyEnc = encrypt(input.apiKey); next.keyHint = `${input.apiKey.slice(0, 8)}…${input.apiKey.slice(-4)}`;
  }
  if (!next.keyEnc) throw new AppError("validation_failed", "Add the payouts key first.", [{ path: "apiKey", message: "Required" }]);
  try {
    next.financialAccounts = await fetchFinancialAccounts(decrypt(next.keyEnc));
    next.lastError = null;
  } catch (e) { throw asAppError(e, "apiKey"); }
  next.lastTestedAt = new Date().toISOString();
  const wanted = input.financialAccountId ?? next.financialAccountId;
  next.financialAccountId = next.financialAccounts.find((f) => f.id === wanted)?.id ?? next.financialAccounts[0]?.id ?? null;
  if (!next.financialAccountId) next.lastError = "The key works, but Stripe returned no open financial account. Global Payouts / Treasury may not be enabled on this account.";
  all[input.mode] = next;
  await db.transaction(async (tx) => {
    await tx.update(schema.acctSettings).set({ payoutSettings: all }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: "payouts.settings_updated", old: { keyHint: prev.keyHint ?? null, financialAccountId: prev.financialAccountId ?? null }, new: { keyHint: next.keyHint, financialAccountId: next.financialAccountId }, extra: { mode: input.mode } });
  });
  return getPayoutSettings(a.orgId, input.mode);
}

// ---------- recipients ----------
export async function listRecipients(orgId: string, mode: Mode) {
  const { key } = await conn(orgId, mode);
  const out: Array<{ id: string; name: string; email: string | null; country: string | null }> = [];
  let page: string | null = null;
  try {
    for (let i = 0; i < 10; i++) {
      const r: Record<string, unknown> = await v2(key, "GET", page ? `/v2/core/accounts?page=${encodeURIComponent(page)}` : "/v2/core/accounts?applied_configurations=recipient&limit=100");
      for (const x of (r.data as Array<Record<string, unknown>> | undefined) ?? []) {
        const identity = x.identity as { country?: string } | null | undefined;
        out.push({ id: String(x.id), name: String(x.display_name ?? x.contact_email ?? x.id), email: (x.contact_email as string | undefined) ?? null, country: identity?.country?.toUpperCase() ?? null });
      }
      page = (r.next_page_url as string | null | undefined) ? new URL(String(r.next_page_url), "https://api.stripe.com").searchParams.get("page") : null;
      if (!page) break;
    }
  } catch (e) { throw asAppError(e); }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** Pure: label for a v2 PayoutMethod, e.g. "Barclays ••1234 (GB)". Unit-tested. */
export function payoutMethodLabel(m: Record<string, unknown>): string {
  const b = (m.bank_account ?? null) as { bank_name?: string | null; last4?: string | null; country?: string | null } | null;
  const c = (m.card ?? null) as { brand?: string | null; last4?: string | null } | null;
  if (b) return `${b.bank_name ?? "Bank account"} ••${b.last4 ?? "????"}${b.country ? ` (${b.country.toUpperCase()})` : ""}`;
  if (c) return `${c.brand ?? "Card"} ••${c.last4 ?? "????"}`;
  return String(m.type ?? "Payout method");
}

export async function recipientPayoutMethods(orgId: string, mode: Mode, recipientId: string) {
  const { key } = await conn(orgId, mode);
  try {
    const r = await v2(key, "GET", "/v2/money_management/payout_methods?limit=50", { context: recipientId });
    return ((r.data as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((m) => m.usage_status === undefined || (m.usage_status as { payments?: string })?.payments !== "invalid")
      .map((m) => ({ id: String(m.id), type: String(m.type ?? ""), label: payoutMethodLabel(m) }));
  } catch (e) { throw asAppError(e, "recipientId"); }
}

export const LinkInput = z.object({ payeeType: z.enum(["ORGANISER", "PARTNER"]), payeeId: z.string().uuid(), recipientId: z.string().regex(/^acct_[A-Za-z0-9]+$/).nullable() });
export async function linkRecipient(a: Actor, input: z.infer<typeof LinkInput>) {
  return db.transaction(async (tx) => {
    const set = { stripeRecipientId: input.recipientId, updatedAt: new Date() };
    const [row] = input.payeeType === "ORGANISER"
      ? await tx.update(schema.acctOrganisers).set(set).where(and(eq(schema.acctOrganisers.id, input.payeeId), eq(schema.acctOrganisers.organisationId, a.orgId))).returning({ id: schema.acctOrganisers.id })
      : await tx.update(schema.acctProfitPartners).set(set).where(and(eq(schema.acctProfitPartners.id, input.payeeId), eq(schema.acctProfitPartners.organisationId, a.orgId))).returning({ id: schema.acctProfitPartners.id });
    if (!row) throw new AppError("not_found", "Payee not found");
    await acctAudit(tx, { ...a, action: "payouts.recipient_linked", entity: input.payeeType.toLowerCase(), entityId: input.payeeId, new: { recipientId: input.recipientId } });
    return { ok: true };
  });
}

// ---------- payees ----------
/** Everyone Bilit can pay from here, with what is owed per currency (organisers: settlement remaining; partners: share owed; bills: unpaid total). */
export async function payees(orgId: string, mode: Mode) {
  const live = isLive(mode);
  const [orgs, bal, partners, bills] = await Promise.all([
    db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.organisationId, orgId), eq(schema.acctOrganisers.active, true))),
    organiserBalances(orgId, mode),
    db.select().from(schema.acctProfitPartners).where(and(eq(schema.acctProfitPartners.organisationId, orgId), eq(schema.acctProfitPartners.active, true))),
    db.select().from(schema.acctBills).where(and(eq(schema.acctBills.organisationId, orgId), eq(schema.acctBills.livemode, live), eq(schema.acctBills.kind, "BILL"), eq(schema.acctBills.status, "UNPAID"))).orderBy(schema.acctBills.dueDate),
  ]);
  const partnerOwed = await Promise.all(partners.map(async (p) => (await partnerOverview(orgId, mode, p.id)).totals.filter((t) => t.owed > 0).map((t) => ({ currency: t.currency, amount: t.owed }))));
  return {
    organisers: orgs.map((o) => ({ id: o.id, name: o.name, recipientId: o.stripeRecipientId, owed: bal.filter((b) => b.organiserId === o.id && b.remaining > 0).map((b) => ({ currency: b.currency, amount: b.remaining })) }))
      .sort((x, y) => Number(y.owed.length > 0) - Number(x.owed.length > 0) || x.name.localeCompare(y.name)),
    partners: partners.map((p, i) => ({ id: p.id, name: p.name, recipientId: p.stripeRecipientId, owed: partnerOwed[i]! })),
    bills: bills.map((b) => ({ id: b.id, name: b.supplierName, invoiceNumber: b.invoiceNumber, dueDate: b.dueDate, currency: b.currency, amount: b.totalAmount, recipientId: null as string | null })),
  };
}

type Payee = { name: string; owed: number | null; organiserId?: string; partnerId?: string; billId?: string };
async function resolvePayee(orgId: string, mode: Mode, type: "ORGANISER" | "PARTNER" | "BILL", id: string, currency: string): Promise<Payee> {
  if (type === "ORGANISER") {
    const [o] = await db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, id), eq(schema.acctOrganisers.organisationId, orgId)));
    if (!o) throw new AppError("not_found", "Organiser not found");
    const b = (await organiserBalances(orgId, mode)).find((x) => x.organiserId === id && x.currency === currency);
    return { name: o.name, owed: b?.remaining ?? 0, organiserId: o.id };
  }
  if (type === "PARTNER") {
    const ov = await partnerOverview(orgId, mode, id);
    return { name: ov.partner.name, owed: ov.totals.find((t) => t.currency === currency)?.owed ?? 0, partnerId: id };
  }
  const [b] = await db.select().from(schema.acctBills).where(and(eq(schema.acctBills.id, id), eq(schema.acctBills.organisationId, orgId), eq(schema.acctBills.livemode, isLive(mode))));
  if (!b || b.kind !== "BILL" || b.status !== "UNPAID") throw new AppError("invalid_state", "Only unpaid supplier invoices can be paid from here.");
  if (b.currency !== currency) throw new AppError("validation_failed", `This invoice is in ${b.currency.toUpperCase()}.`, [{ path: "currency", message: "Currency must match the invoice" }]);
  return { name: b.supplierName, owed: b.totalAmount, billId: b.id };
}

// ---------- prepare / send ----------
export const PayoutInput = z.object({
  mode: ModeSchema,
  payeeType: z.enum(["ORGANISER", "PARTNER", "BILL"]), payeeId: z.string().uuid(),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: Currency,
  recipientId: z.string().regex(/^acct_[A-Za-z0-9]+$/, "Choose the Stripe recipient"),
  payoutMethodId: z.string().trim().min(3).max(120),
  toCurrency: Currency.optional().nullable(),
  description: z.string().trim().max(200).optional().nullable(),
  statementDescriptor: z.string().trim().max(18).regex(/^[A-Za-z0-9 .\-/]*$/, "Letters, numbers, spaces and . - / only").optional().nullable(),
  allowDuplicate: z.boolean().optional(),
  overpay: z.boolean().optional(), // the admin confirmed paying more than the balance owed (organisers / partners only)
});
export const SendInput = PayoutInput.extend({ quoteId: z.string().max(120).optional().nullable(), verificationId: z.string().max(120).optional().nullable(), acknowledgeMismatch: z.boolean().default(false) });

const ACTIVE = ["SENDING", "PROCESSING", "POSTED"];

async function checks(orgId: string, input: z.infer<typeof PayoutInput>, financialAccountId: string, key: string) {
  const payee = await resolvePayee(orgId, input.mode, input.payeeType, input.payeeId, input.currency);
  const warnings: string[] = [];
  if (input.payeeType === "BILL" && input.amount !== payee.owed) throw new AppError("validation_failed", "A supplier invoice is paid in full from here.", [{ path: "amount", message: "Use the invoice total" }]);
  if (input.payeeType !== "BILL" && input.amount > (payee.owed ?? 0) && !input.overpay) throw new AppError("validation_failed", `That is more than the ${input.currency.toUpperCase()} balance owed to ${payee.name}. Tick "pay more than owed" if this is intended.`, [{ path: "amount", message: "More than owed" }]);
  let fa: FinancialAccount;
  try { fa = parseFinancialAccount(await v2(key, "GET", `/v2/money_management/financial_accounts/${encodeURIComponent(financialAccountId)}`)); }
  catch (e) { throw asAppError(e); }
  const available = fa.balances[input.currency] ?? 0;
  if (available < input.amount) throw new AppError("invalid_state", `Not enough ${input.currency.toUpperCase()} in the Stripe financial account (available ${(available / 100).toFixed(2)}). Add funds in Stripe first.`);
  const o = schema.acctStripeOutbound;
  const recent = await db.select({ id: o.id, amount: o.amount, createdAt: o.createdAt, status: o.status }).from(o).where(and(
    eq(o.organisationId, orgId), eq(o.livemode, isLive(input.mode)), eq(o.payeeType, input.payeeType),
    eq(input.payeeType === "ORGANISER" ? o.organiserId : input.payeeType === "PARTNER" ? o.partnerId : o.billId, input.payeeId),
    inArray(o.status, ACTIVE), gte(o.createdAt, new Date(Date.now() - 3 * 86_400_000)),
  ));
  if (input.payeeType === "BILL" && recent.length) throw new AppError("invalid_state", "A Stripe payment for this invoice is already in progress or sent.");
  const dup = recent.find((r) => r.amount === input.amount);
  if (dup && !input.allowDuplicate) throw new AppError("conflict", `A payment of the same amount to ${payee.name} was sent ${dup.createdAt.toISOString().slice(0, 10)} (${dup.status.toLowerCase()}). Confirm it is a separate payment to continue.`, { duplicatePayout: dup.id });
  if (input.payeeType !== "BILL" && input.amount > (payee.owed ?? 0)) warnings.push(`Pays ${((input.amount - (payee.owed ?? 0)) / 100).toFixed(2)} ${input.currency.toUpperCase()} more than is owed.`);
  return { payee, available, warnings };
}

/** Everything the admin needs to see before sending: balance owed, money available, Stripe's quote (fees, FX) and the payee-name check. Moves nothing. */
export async function preparePayout(orgId: string, input: z.infer<typeof PayoutInput>) {
  const { key, financialAccountId } = await conn(orgId, input.mode);
  const { payee, available, warnings } = await checks(orgId, input, financialAccountId, key);
  const to = { recipient: input.recipientId, payout_method: input.payoutMethodId, currency: input.toCurrency ?? input.currency };
  let quote: { id: string; fees: Array<{ type: string; amount: number; currency: string }>; feeTotal: number; credited: { amount: number; currency: string } | null; rate: string | null; expiresAt: string | null } | null = null;
  try {
    const q = await v2(key, "POST", "/v2/money_management/outbound_payment_quotes", { body: { from: { financial_account: financialAccountId, currency: input.currency }, to, amount: { value: input.amount, currency: input.currency } } });
    const fees = ((q.estimated_fees as Array<{ type: string; amount: unknown }> | undefined) ?? []).map((f) => ({ type: f.type, amount: minor(f.amount), currency: ((f.amount as { currency?: string })?.currency ?? input.currency).toLowerCase() }));
    const fx = q.fx_quote as { rates?: Record<string, { exchange_rate?: string }>; lock_expires_at?: string } | null | undefined;
    const credited = (q.to as { credited?: { value: unknown; currency: string } } | undefined)?.credited;
    quote = { id: String(q.id), fees, feeTotal: fees.filter((f) => f.currency === input.currency).reduce((s, f) => s + f.amount, 0), credited: credited ? { amount: minor(credited), currency: credited.currency.toLowerCase() } : null, rate: fx?.rates?.[input.currency]?.exchange_rate ?? null, expiresAt: fx?.lock_expires_at ?? null };
  } catch (e) {
    if (e instanceof StripeV2Error && (e.status === 401 || e.status === 403 || e.unknown)) throw asAppError(e);
    if (input.toCurrency && input.toCurrency !== input.currency) throw asAppError(e); // a cross-currency payment needs its quote
    warnings.push(`Stripe gave no fee quote (${e instanceof Error ? e.message : "error"}); fees will show in Stripe after sending.`);
  }
  // Confirmation of Payee (UK, GBP) / Verification of Payee (SEPA, EUR): the bank's name check on the recipient account.
  let verification: { id: string; result: string; matchedName: string | null; message: string | null } | null = null;
  if (input.currency === "gbp" || input.currency === "eur") {
    try {
      const r = await v2(key, "POST", "/v2/money_management/recipient_verifications", { body: { recipient: input.recipientId, payout_method: input.payoutMethodId } });
      const d = (r.match_result_details ?? {}) as { matched_name?: string; message?: string };
      verification = { id: String(r.id), result: String(r.match_result ?? r.status ?? "unknown"), matchedName: d.matched_name ?? null, message: d.message ?? null };
    } catch (e) {
      if (e instanceof StripeV2Error && (e.status === 401 || e.unknown)) throw asAppError(e);
      warnings.push(`Payee name check not available for this payment (${e instanceof Error ? e.message : "error"}).`);
    }
  }
  return { payee: { name: payee.name, owed: payee.owed }, available, financialAccountId, quote, verification, warnings };
}

const STATUS: Record<string, string> = { processing: "PROCESSING", posted: "POSTED", failed: "FAILED", returned: "RETURNED", canceled: "CANCELED" };
const GONE = new Set(["FAILED", "RETURNED", "CANCELED"]);

function failureOf(obp: Record<string, unknown>): string | null {
  const d = obp.status_details as Record<string, { reason?: string } | null> | null | undefined;
  const r = d?.failed?.reason ?? d?.returned?.reason ?? null;
  return r ? String(r).replace(/_/g, " ") : null;
}

type Row = typeof schema.acctStripeOutbound.$inferSelect;

/** Book the payment once Stripe has accepted it. Idempotent: skipped when the row already has its book entry. */
async function book(a: Actor, row: Row): Promise<Row> {
  const mode: Mode = row.livemode ? "live" : "test";
  const { timezone } = await getAcctSettings(row.organisationId);
  const date = localDate(row.createdAt, timezone);
  const notes = `Sent from Bilit finance via Stripe (${row.payoutMethodLabel ?? row.recipientId})${row.description ? ` — ${row.description}` : ""}`;
  const o = schema.acctStripeOutbound;
  if (row.payeeType === "ORGANISER" && !row.organiserPaymentId) {
    const p = await recordOrganiserPayment(a, { mode, organiserId: row.organiserId!, eventId: row.eventId, amount: row.amount, currency: row.currency, paymentDate: date, bankReference: row.stripeId, method: "STRIPE_TRANSFER", notes, status: "PAID" });
    [row] = await db.update(o).set({ organiserPaymentId: p.id, updatedAt: new Date() }).where(eq(o.id, row.id)).returning() as [Row];
  } else if (row.payeeType === "PARTNER" && !row.partnerPaymentId) {
    const p = await recordPartnerPayment(a, { mode, partnerId: row.partnerId!, amount: row.amount, currency: row.currency, paymentDate: date, method: "STRIPE_TRANSFER", bankReference: row.stripeId, notes });
    [row] = await db.update(o).set({ partnerPaymentId: p.id, updatedAt: new Date() }).where(eq(o.id, row.id)).returning() as [Row];
  } else if (row.payeeType === "BILL") {
    const [b] = await db.select({ status: schema.acctBills.status }).from(schema.acctBills).where(eq(schema.acctBills.id, row.billId!));
    if (b?.status === "UNPAID") await payBill(a, row.billId!, { paidDate: date, paidFrom: "BANK", paymentReference: row.stripeId });
  }
  return row;
}

/** Undo the book entry of a payment Stripe reports as failed / returned / cancelled. */
async function unbook(a: Actor, row: Row) {
  const reason = `Stripe payment ${row.stripeId} ${row.status.toLowerCase()}${row.failure ? `: ${row.failure}` : ""}`.slice(0, 1000);
  if (row.organiserPaymentId) {
    const [p] = await db.select({ status: schema.acctOrganiserPayments.status }).from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.id, row.organiserPaymentId));
    if (p && p.status !== "VOIDED") await voidOrganiserPayment(a, row.organiserPaymentId, reason);
  }
  if (row.partnerPaymentId) {
    const [p] = await db.select({ status: schema.acctPartnerPayments.status }).from(schema.acctPartnerPayments).where(eq(schema.acctPartnerPayments.id, row.partnerPaymentId));
    if (p && p.status !== "VOIDED") await voidPartnerPayment(a, row.partnerPaymentId, reason);
  }
  if (row.payeeType === "BILL" && row.billId) {
    const [b] = await db.select({ status: schema.acctBills.status, ref: schema.acctBills.paymentReference }).from(schema.acctBills).where(eq(schema.acctBills.id, row.billId));
    if (b?.status === "PAID" && b.ref === row.stripeId) await unpayBill(a, row.billId, reason);
  }
}

/** Store Stripe's view of the payment and keep the books in step with it. */
async function apply(a: Actor, row: Row, obp: Record<string, unknown>): Promise<Row> {
  const status = STATUS[String(obp.status)] ?? "PROCESSING";
  const o = schema.acctStripeOutbound;
  const credited = (obp.to as { credited?: unknown } | undefined)?.credited;
  const [next] = await db.update(o).set({ stripeId: String(obp.id), stripeStatus: String(obp.status), status, failure: failureOf(obp), creditedAmount: credited ? minor(credited) : row.creditedAmount, raw: obp, updatedAt: new Date() }).where(eq(o.id, row.id)).returning();
  let r = next!;
  if (r.status !== row.status || !row.stripeId) {
    await db.transaction((tx) => acctAudit(tx, { ...a, action: "payouts.status", entity: "stripe_outbound", entityId: r.id, old: { status: row.status }, new: { status: r.status, stripeId: r.stripeId }, extra: { failure: r.failure } }));
  }
  if (GONE.has(r.status)) await unbook(a, r);
  else if (!row.stripeId) r = await book(a, r); // first time Stripe accepted it; later syncs never re-book something an admin undid by hand
  return r;
}

const createBody = (row: Row, quoteId: string | null, verificationId: string | null) => ({
  from: { financial_account: row.financialAccountId, currency: row.currency },
  to: { recipient: row.recipientId, payout_method: row.payoutMethodId, currency: row.toCurrency ?? row.currency },
  amount: { value: row.amount, currency: row.currency },
  ...(row.description ? { description: row.description } : {}),
  ...(row.statementDescriptor ? { statement_descriptor: row.statementDescriptor } : {}),
  ...(quoteId ? { outbound_payment_quote: quoteId } : {}),
  ...(verificationId ? { recipient_verification: verificationId } : {}),
  metadata: { bilit_payout_id: row.id, payee_type: row.payeeType.toLowerCase() },
});
const idemKey = (row: Row) => `bilit-obp-${row.id}`;

/** Send the money. Route requires accounting.admin + a fresh re-authentication. */
export async function sendPayout(a: Actor, input: z.infer<typeof SendInput>) {
  const { key, financialAccountId } = await conn(a.orgId, input.mode);
  const { payee } = await checks(a.orgId, input, financialAccountId, key);
  let verificationResult: string | null = null;
  if (input.verificationId) {
    try {
      const v = await v2(key, "GET", `/v2/money_management/recipient_verifications/${encodeURIComponent(input.verificationId)}`);
      verificationResult = String(v.match_result ?? v.status ?? "unknown");
      if (verificationResult !== "match" && String(v.status) !== "acknowledged") {
        if (!input.acknowledgeMismatch) throw new AppError("validation_failed", `The bank's name check did not fully match (${verificationResult.replace(/_/g, " ")}). Confirm you have checked the account to send anyway.`, [{ path: "acknowledgeMismatch", message: "Confirm the name check" }]);
        await v2(key, "POST", `/v2/money_management/recipient_verifications/${encodeURIComponent(input.verificationId)}/acknowledge`);
      }
    } catch (e) { throw asAppError(e); }
  }
  const o = schema.acctStripeOutbound;
  const [row] = await db.insert(o).values({
    organisationId: a.orgId, livemode: isLive(input.mode), payeeType: input.payeeType,
    organiserId: payee.organiserId ?? null, partnerId: payee.partnerId ?? null, billId: payee.billId ?? null, payeeName: payee.name,
    recipientId: input.recipientId, payoutMethodId: input.payoutMethodId, payoutMethodLabel: null, financialAccountId,
    amount: input.amount, currency: input.currency, toCurrency: input.toCurrency && input.toCurrency !== input.currency ? input.toCurrency : null,
    description: input.description ?? null, statementDescriptor: input.statementDescriptor ?? null, quoteId: input.quoteId ?? null,
    verificationId: input.verificationId ?? null, verificationResult, status: "SENDING", createdBy: a.userId,
  }).returning();
  let r = row!;
  if (input.quoteId) {
    try {
      const q = await v2(key, "GET", `/v2/money_management/outbound_payment_quotes/${encodeURIComponent(input.quoteId)}`);
      const fee = ((q.estimated_fees as Array<{ amount: unknown }> | undefined) ?? []).filter((f) => ((f.amount as { currency?: string })?.currency ?? input.currency).toLowerCase() === input.currency).reduce((t, f) => t + minor(f.amount), 0);
      [r] = await db.update(o).set({ feeAmount: fee }).where(eq(o.id, r.id)).returning() as [Row];
    } catch { /* fee is information only */ }
  }
  try {
    const methods = await recipientPayoutMethods(a.orgId, input.mode, input.recipientId).catch(() => []);
    const label = methods.find((m) => m.id === input.payoutMethodId)?.label ?? null;
    if (label) [r] = await db.update(o).set({ payoutMethodLabel: label }).where(eq(o.id, r.id)).returning() as [Row];
  } catch { /* label is cosmetic */ }
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "payouts.sending", entity: "stripe_outbound", entityId: r.id, new: { payee: payee.name, payeeType: input.payeeType, amount: input.amount, currency: input.currency, toCurrency: input.toCurrency ?? null, recipientId: input.recipientId, verification: verificationResult } }));
  let obp: Record<string, unknown>;
  try {
    obp = await v2(key, "POST", "/v2/money_management/outbound_payments", { body: createBody(r, input.quoteId ?? null, input.verificationId ?? null), idempotencyKey: idemKey(r) });
  } catch (e) {
    if (e instanceof StripeV2Error && !e.unknown) {
      await db.update(o).set({ status: "REJECTED", failure: e.message, updatedAt: new Date() }).where(eq(o.id, r.id));
      await db.transaction((tx) => acctAudit(tx, { ...a, action: "payouts.rejected", entity: "stripe_outbound", entityId: r.id, extra: { error: e.message } }));
      throw asAppError(e);
    }
    await db.update(o).set({ failure: e instanceof Error ? e.message : "unknown", updatedAt: new Date() }).where(eq(o.id, r.id));
    log.warn("payouts.outcome_unknown", { id: r.id, error: e instanceof Error ? e.message : String(e) });
    throw new AppError("invalid_state", "Stripe did not confirm the payment. Do NOT send it again: Bilit re-checks it automatically (Send money → Refresh) and books it once Stripe answers.");
  }
  return apply(a, r, obp);
}

// ---------- status ----------
/** Re-check open payments with Stripe: retries an unanswered create with the same idempotency key (never a second payment), then follows the status. */
export async function syncPayouts(orgId: string, mode: Mode, actor?: Actor) {
  const s = (await stored(orgId))[mode];
  if (!s?.keyEnc) return { checked: 0 };
  const key = decrypt(s.keyEnc);
  const o = schema.acctStripeOutbound;
  const open = await db.select().from(o).where(and(eq(o.organisationId, orgId), eq(o.livemode, isLive(mode)), inArray(o.status, ["SENDING", "PROCESSING"])));
  let checked = 0;
  for (const row of open) {
    const a: Actor = actor ?? { orgId, userId: row.createdBy!, ctx: SYSTEM_CTX };
    try {
      let obp: Record<string, unknown>;
      if (row.stripeId) obp = await v2(key, "GET", `/v2/money_management/outbound_payments/${encodeURIComponent(row.stripeId)}`);
      else if (Date.now() - row.createdAt.getTime() < 23 * 3_600_000) obp = await v2(key, "POST", "/v2/money_management/outbound_payments", { body: createBody(row, null, row.verificationId), idempotencyKey: idemKey(row) });
      else { await db.update(o).set({ failure: "No answer from Stripe within 23 hours — check Stripe → Payouts and void or record manually.", updatedAt: new Date() }).where(eq(o.id, row.id)); continue; }
      await apply(a, row, obp);
      checked++;
    } catch (e) {
      if (e instanceof StripeV2Error && !e.unknown && !row.stripeId) await db.update(o).set({ status: "REJECTED", failure: e.message, updatedAt: new Date() }).where(eq(o.id, row.id));
      log.warn("payouts.sync_failed", { id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checked };
}

export async function syncAllPayouts() {
  if (!accountingEnabled()) return 0;
  const rows = await db.select({ orgId: schema.acctSettings.organisationId, v: schema.acctSettings.payoutSettings }).from(schema.acctSettings);
  let n = 0;
  for (const r of rows) for (const mode of ["live", "test"] as const) {
    if (!(r.v as Stored)?.[mode]?.keyEnc) continue;
    try { n += (await syncPayouts(r.orgId, mode)).checked; } catch (e) { log.warn("payouts.sync_all_failed", { orgId: r.orgId, mode, error: e instanceof Error ? e.message : String(e) }); }
  }
  return n;
}

export async function cancelPayout(a: Actor, id: string) {
  const o = schema.acctStripeOutbound;
  const [row] = await db.select().from(o).where(and(eq(o.id, id), eq(o.organisationId, a.orgId)));
  if (!row) throw new AppError("not_found", "Payment not found");
  if (row.status !== "PROCESSING" || !row.stripeId) throw new AppError("invalid_state", "Only a payment Stripe is still processing can be cancelled.");
  const { key } = await conn(a.orgId, row.livemode ? "live" : "test");
  let obp: Record<string, unknown>;
  try { obp = await v2(key, "POST", `/v2/money_management/outbound_payments/${encodeURIComponent(row.stripeId)}/cancel`, { idempotencyKey: `bilit-obp-cancel-${row.id}` }); }
  catch (e) { throw asAppError(e); }
  return apply(a, row, obp);
}

export async function listPayouts(orgId: string, mode: Mode, page: { limit: number; offset: number }) {
  const o = schema.acctStripeOutbound;
  const where = and(eq(o.organisationId, orgId), eq(o.livemode, isLive(mode)));
  const [items, [{ n } = { n: 0 }]] = await Promise.all([
    db.select({ id: o.id, payeeType: o.payeeType, payeeName: o.payeeName, organiserId: o.organiserId, partnerId: o.partnerId, billId: o.billId, amount: o.amount, currency: o.currency, toCurrency: o.toCurrency, creditedAmount: o.creditedAmount, feeAmount: o.feeAmount, payoutMethodLabel: o.payoutMethodLabel, description: o.description, stripeId: o.stripeId, status: o.status, failure: o.failure, verificationResult: o.verificationResult, createdAt: o.createdAt, updatedAt: o.updatedAt })
      .from(o).where(where).orderBy(desc(o.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(o).where(where),
  ]);
  return { items, total: n };
}

/** Available balance per currency in the source financial account (live from Stripe). */
export async function payoutBalance(orgId: string, mode: Mode) {
  const s = (await stored(orgId))[mode];
  if (!s?.keyEnc || !s.financialAccountId) return null;
  try { return parseFinancialAccount(await v2(decrypt(s.keyEnc), "GET", `/v2/money_management/financial_accounts/${encodeURIComponent(s.financialAccountId)}`)); }
  catch (e) { throw asAppError(e); }
}
