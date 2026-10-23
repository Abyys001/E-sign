import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { currencyExponent } from "@/lib/money";
import { getAcctSettings, isLive, type Mode } from "./core";

/**
 * The single place where event, organiser and overview financials are calculated. Every figure comes from the ledger
 * (journal lines tagged with event/organiser) or from the Stripe transactions that produced those lines, so each number
 * is traceable to its postings. Amounts are integer minor units and never mix currencies.
 *
 * Money flow for one event and currency:
 *   gross ticket sales − refunds − chargebacks                      = net ticket sales
 *   organiser share − Stripe fees recharged − deductions (fees, organiser-borne expenses, adjustments) = due to organiser
 *   due − paid                                                      = remaining (settlement balance)
 *   booking fee + event fees + other revenue − Stripe fees borne by Bilit − Bilit expenses (− Bilit-borne chargebacks)
 *                                                                   = Bilit profit (revenue − expense accounts)
 */

export type Range = { from?: string | null; to?: string | null };
export type SettlementStatus = "NOTHING_DUE" | "NOT_SETTLED" | "PARTIALLY_PAID" | "FULLY_PAID" | "OVERPAID" | "ORGANISER_OWES";
export const SETTLEMENT_STATUSES: SettlementStatus[] = ["NOT_SETTLED", "PARTIALLY_PAID", "FULLY_PAID", "OVERPAID", "ORGANISER_OWES", "NOTHING_DUE"];

export function settlementStatus(due: number, paid: number): SettlementStatus {
  if (paid > due && paid > 0) return "OVERPAID";
  if (due < 0) return "ORGANISER_OWES"; // e.g. booking fees refunded to customers that the organiser must cover
  if (due <= 0 && paid <= 0) return "NOTHING_DUE";
  if (paid === 0) return "NOT_SETTLED";
  return paid === due ? "FULLY_PAID" : "PARTIALLY_PAID";
}

export type Figures = {
  currency: string;
  tickets: number; orders: number;
  grossSales: number; refunds: number; chargebacks: number; netSales: number;
  bookingFees: number; eventFees: number; otherRevenue: number; bilitRevenue: number;
  processingFees: number; feesRecharged: number; bilitProcessingFees: number;
  organiserShare: number; deductions: number; expensesBilit: number; expensesOrganiser: number; otherCosts: number;
  organiserDue: number; organiserPaid: number; remaining: number; pendingPayments: number; bookingFeesRefunded: number;
  bilitProfit: number; profitShare: number; cashback: number; settlement: SettlementStatus;
};

const ZERO = (currency: string): Figures => ({
  currency, tickets: 0, orders: 0, grossSales: 0, refunds: 0, chargebacks: 0, netSales: 0, bookingFees: 0, eventFees: 0, otherRevenue: 0, bilitRevenue: 0,
  processingFees: 0, feesRecharged: 0, bilitProcessingFees: 0, organiserShare: 0, deductions: 0, expensesBilit: 0, expensesOrganiser: 0, otherCosts: 0,
  organiserDue: 0, organiserPaid: 0, remaining: 0, pendingPayments: 0, bookingFeesRefunded: 0, bilitProfit: 0, profitShare: 0, cashback: 0, settlement: "NOTHING_DUE",
});

type LedgerRow = { dim: string; currency: string; key: string | null; type: string; src: string | null; inp: boolean; d: string; c: string };
type BtRow = { dim: string; currency: string; inp: boolean; tickets: string; orders: string; commission: string };
const n = (v: unknown) => Number(v ?? 0);

/** Fold ledger + Stripe aggregates into figures. Period figures use `inp` rows; settlement (due/paid) is cumulative to `to`. */
function fold(ledger: LedgerRow[], bts: BtRow[], pending: Array<{ dim: string; currency: string; amount: string }>, feeRefunds: Array<{ dim: string; currency: string; amount: string }> = []) {
  const out = new Map<string, Figures>();
  const get = (dim: string, cur: string) => { const k = `${dim}|${cur}`; let f = out.get(k); if (!f) { f = ZERO(cur); out.set(k, f); } return f; };
  for (const r of ledger) {
    const f = get(r.dim, r.currency), d = n(r.d), c = n(r.c), cr = c - d, dr = d - c;
    // Settlement is cumulative (everything up to the end of the range), the rest is period activity.
    if (r.key === "organiser_payable") {
      if (r.src === "organiser_payment") f.organiserPaid += dr; else f.organiserDue += cr;
      if (r.src !== "organiser_payment" && r.src !== "stripe_balance_transaction" && r.src !== "organiser_cashback" && r.src !== "ticket_import" && r.src !== "manual_sale" && r.src !== "manual_refund" && r.inp) f.deductions += dr;
      if (r.src === "event_expense" && r.inp) f.expensesOrganiser += dr;
    }
    if (!r.inp) continue;
    switch (r.key) {
      // A sale taken outside the connected Stripe account (e.g. Bilit's other Stripe): gross − organiser share is booking fee.
      case "ticket_sales": f.grossSales += cr; if (r.src === "manual_sale") f.bookingFees += cr; break;
      case "refunds": f.refunds += dr; break;
      case "chargebacks": f.chargebacks += dr; break;
      case "stripe_fees": f.processingFees += dr; break;
      case "stripe_fee_recharges": f.feesRecharged += cr; break;
      case "bilit_commission": f.eventFees += cr; break;
      case "other_revenue": f.otherRevenue += cr; break;
      // A ticket-export correction moves booking fee to the organiser: it lowers the booking fee, not a deduction.
      case "organiser_share": f.organiserShare += dr; if (r.src === "ticket_import" || r.src === "manual_sale") f.bookingFees -= dr; break;
      case "other_expenses": if (r.src === "event_expense") f.expensesBilit += dr; else f.otherCosts += dr; break;
      case "profit_share": f.profitShare += dr; break;
      case "organiser_cashback": f.cashback += dr; break;
    }
    if (r.type === "REVENUE") f.bilitProfit += cr;
    if (r.type === "EXPENSE") f.bilitProfit -= dr;
  }
  for (const b of bts) {
    if (!b.inp) continue;
    const f = get(b.dim, b.currency);
    f.tickets += n(b.tickets); f.orders += n(b.orders); f.bookingFees += n(b.commission);
  }
  for (const p of pending) get(p.dim, p.currency).pendingPayments += n(p.amount);
  for (const r of feeRefunds) get(r.dim, r.currency).bookingFeesRefunded += n(r.amount);
  for (const f of out.values()) {
    f.netSales = f.grossSales - f.refunds - f.chargebacks;
    f.bilitRevenue = f.bookingFees + f.eventFees + f.otherRevenue;
    f.bilitProcessingFees = f.processingFees - f.feesRecharged;
    f.remaining = f.organiserDue - f.organiserPaid;
    f.settlement = settlementStatus(f.organiserDue, f.organiserPaid);
  }
  return out;
}

async function aggregate(orgId: string, mode: Mode, dim: "event" | "organiser", r: Range, filter: { eventIds?: string[]; organiserId?: string }) {
  const col = dim === "event" ? sql.raw("l.event_id") : sql.raw("l.organiser_id");
  const btCol = dim === "event" ? sql.raw("bt.event_id") : sql.raw("bt.organiser_id");
  const payCol = dim === "event" ? sql.raw("p.event_id") : sql.raw("p.organiser_id");
  const from = r.from ?? null, to = r.to ?? null;
  const evF = (c: SQL) => filter.eventIds ? (filter.eventIds.length ? sql` and ${c} in (${sql.join(filter.eventIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql` and false`) : sql``;
  const orgF = (c: SQL) => filter.organiserId ? sql` and ${c} = ${filter.organiserId}::uuid` : sql``;
  const saleCol = dim === "event" ? sql.raw("s.event_id") : sql.raw("s.organiser_id");
  const [ledger, bts, pending, feeRefunds] = await Promise.all([
    db.execute<LedgerRow>(sql`
      select ${col}::text as dim, e.currency, a.system_key as key, a.type, e.source_type as src, ${from ? sql`e.entry_date >= ${from}::date` : sql`true`} as inp,
        sum(l.debit)::text as d, sum(l.credit)::text as c
      from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and ${col} is not null ${to ? sql` and e.entry_date <= ${to}::date` : sql``}
        ${evF(sql.raw("l.event_id"))} ${orgF(sql.raw("l.organiser_id"))}
      group by 1, 2, 3, 4, 5, 6`),
    db.execute<BtRow>(sql`
      select ${btCol}::text as dim, bt.currency, ${from ? sql`e.entry_date >= ${from}::date` : sql`true`} as inp,
        sum(case when bt.kind = 'SALE' then coalesce(bt.ticket_quantity, 1) else 0 end)::text as tickets,
        count(*) filter (where bt.kind = 'SALE')::text as orders, coalesce(sum(bt.commission_amount), 0)::text as commission
      from stripe_balance_transactions bt join acct_journal_entries e on e.id = bt.posted_entry_id
      where bt.organisation_id = ${orgId} and bt.livemode = ${isLive(mode)} and bt.match_status = 'MATCHED' and ${btCol} is not null ${to ? sql` and e.entry_date <= ${to}::date` : sql``}
        ${evF(sql.raw("bt.event_id"))} ${orgF(sql.raw("bt.organiser_id"))}
      group by 1, 2, 3`),
    db.execute<{ dim: string; currency: string; amount: string }>(sql`
      select ${payCol}::text as dim, p.currency, sum(p.amount)::text as amount from acct_organiser_payments p
      where p.organisation_id = ${orgId} and p.livemode = ${isLive(mode)} and p.status = 'PENDING' and ${payCol} is not null ${evF(sql.raw("p.event_id"))} ${orgF(sql.raw("p.organiser_id"))}
      group by 1, 2`),
    // Booking fee handed back to customers (refunded beyond the ticket price). Under the non-refundable policy this is
    // charged to the organiser, so it is what Bilit recovers from them.
    db.execute<{ dim: string; currency: string; amount: string }>(sql`
      with c as (
        select ${saleCol}::text as dim, s.currency, s.amount - coalesce(s.commission_amount, 0) as ticket,
          (select coalesce(sum(-r.amount), 0) from stripe_balance_transactions r where r.stripe_account_ref = s.stripe_account_ref and r.charge_id = s.charge_id and r.kind in ('REFUND', 'DISPUTE', 'DISPUTE_REVERSAL')) as refunded
        from stripe_balance_transactions s
        where s.organisation_id = ${orgId} and s.livemode = ${isLive(mode)} and s.kind = 'SALE' and s.match_status = 'MATCHED' and ${saleCol} is not null ${evF(sql.raw("s.event_id"))} ${orgF(sql.raw("s.organiser_id"))})
      select dim, currency, sum(greatest(0, refunded - ticket))::text as amount from c group by 1, 2`),
  ]);
  return fold(ledger.rows, bts.rows, pending.rows, feeRefunds.rows);
}

// ---------- events ----------
export type EventFinanceFilter = Range & { q?: string; organiserId?: string; currency?: string; status?: string; settlement?: SettlementStatus; payments?: "PENDING" | "NONE"; eventIds?: string[] };

export type EventFinanceRow = Figures & {
  eventId: string; eventName: string; eventCode: string; eventStatus: string; startsOn: string | null; eventCurrency: string;
  organiserId: string | null; organiserName: string | null; bookingFeeBps: number | null; stripeFeesBorneBy: string | null;
};

/** One row per event × currency (the event's own currency when it has no money yet). */
export async function eventFinancials(orgId: string, mode: Mode, f: EventFinanceFilter = {}): Promise<EventFinanceRow[]> {
  const e = schema.acctEvents;
  const evs = await db.select({ e, organiserName: schema.acctOrganisers.name, bps: schema.acctAgreements.percentBps, feesBy: schema.acctAgreements.stripeFeesBorneBy })
    .from(e).leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, e.organiserId)).leftJoin(schema.acctAgreements, eq(schema.acctAgreements.id, e.currentAgreementId))
    .where(and(eq(e.organisationId, orgId), f.organiserId ? eq(e.organiserId, f.organiserId) : undefined, f.status ? eq(e.status, f.status) : undefined,
      f.eventIds ? (f.eventIds.length ? inArray(e.id, f.eventIds) : sql`false`) : undefined,
      f.q ? sql`(${e.name} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`} or ${e.code} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`})` : undefined));
  if (!evs.length) return [];
  const figs = await aggregate(orgId, mode, "event", f, { eventIds: evs.map((x) => x.e.id) });
  const rows: EventFinanceRow[] = [];
  for (const x of evs) {
    const mine = [...figs.entries()].filter(([k]) => k.startsWith(`${x.e.id}|`)).map(([, v]) => v);
    const list = mine.length ? mine : [ZERO(x.e.currency)];
    for (const v of list) rows.push({ ...v, eventId: x.e.id, eventName: x.e.name, eventCode: x.e.code, eventStatus: x.e.status, startsOn: x.e.startsOn, eventCurrency: x.e.currency, organiserId: x.e.organiserId, organiserName: x.organiserName, bookingFeeBps: x.bps, stripeFeesBorneBy: x.feesBy });
  }
  return rows
    .filter((r) => (!f.currency || r.currency === f.currency) && (!f.settlement || r.settlement === f.settlement) && (!f.payments || (f.payments === "PENDING" ? r.pendingPayments > 0 : r.pendingPayments === 0)))
    .sort((a, b) => (b.startsOn ?? "").localeCompare(a.startsOn ?? "") || a.eventName.localeCompare(b.eventName) || a.currency.localeCompare(b.currency));
}

/** Totals of a set of figure rows, per currency. */
export function totalsByCurrency(rows: Figures[]): Figures[] {
  const by = new Map<string, Figures>();
  for (const r of rows) {
    const t = by.get(r.currency) ?? ZERO(r.currency);
    for (const k of Object.keys(t) as Array<keyof Figures>) if (typeof t[k] === "number") (t[k] as number) += r[k] as number;
    by.set(r.currency, t);
  }
  for (const t of by.values()) t.settlement = settlementStatus(t.organiserDue, t.organiserPaid);
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

// ---------- organisers ----------
/** Organiser financial account: totals per currency (all their activity, including payments not tied to an event) + per-event rows. */
export async function organiserFinancials(orgId: string, mode: Mode, organiserId: string, r: Range = {}) {
  const [figs, events, eventCount] = await Promise.all([
    aggregate(orgId, mode, "organiser", r, { organiserId }),
    eventFinancials(orgId, mode, { ...r, organiserId }),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.acctEvents).where(and(eq(schema.acctEvents.organisationId, orgId), eq(schema.acctEvents.organiserId, organiserId))),
  ]);
  const totals = [...figs.entries()].filter(([k]) => k.startsWith(`${organiserId}|`)).map(([, v]) => v).sort((a, b) => a.currency.localeCompare(b.currency));
  return { eventCount: eventCount[0]?.n ?? 0, totals, events };
}

/** Settlement balance (due / paid / remaining) of every organiser, per currency, all time. */
export async function organiserBalances(orgId: string, mode: Mode) {
  const figs = await aggregate(orgId, mode, "organiser", {}, {});
  return [...figs.entries()].map(([k, v]) => ({ organiserId: k.split("|")[0]!, ...v })).filter((x) => x.organiserId && x.organiserId !== "null");
}

// ---------- overview ----------
export type FxConfig = { reportingCurrency: string | null; rates: Record<string, string> };

export async function fxConfig(orgId: string): Promise<FxConfig> {
  const s = await getAcctSettings(orgId);
  return { reportingCurrency: s.reportingCurrency, rates: s.fxRates };
}

/** Indicative conversion for reporting only (never posted). Returns null when no rate is configured for the currency. */
export function convert(minor: number, from: string, fx: FxConfig): number | null {
  if (!fx.reportingCurrency) return null;
  if (from === fx.reportingCurrency) return minor;
  const rate = Number(fx.rates[from]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(minor * rate * 10 ** (currencyExponent(fx.reportingCurrency) - currencyExponent(from)));
}

export async function financeOverview(orgId: string, mode: Mode, r: Range) {
  const [events, monthly, fx] = await Promise.all([eventFinancials(orgId, mode, r), monthlySeries(orgId, mode, r), fxConfig(orgId)]);
  const totals = totalsByCurrency(events).map((t) => ({ ...t, events: new Set(events.filter((e) => e.currency === t.currency && (e.grossSales || e.organiserDue || e.organiserPaid || e.expensesBilit)).map((e) => e.eventId)).size }));
  const activeEvents = new Set(events.filter((e) => e.grossSales || e.organiserDue || e.organiserPaid || e.expensesBilit).map((e) => e.eventId)).size;
  const totalEvents = new Set(events.map((e) => e.eventId)).size;
  const byOrganiser = new Map<string, { organiserId: string; organiserName: string; currency: string; remaining: number }>();
  for (const e of events) {
    if (!e.organiserId) continue;
    const k = `${e.organiserId}|${e.currency}`;
    const o = byOrganiser.get(k) ?? { organiserId: e.organiserId, organiserName: e.organiserName ?? "", currency: e.currency, remaining: 0 };
    o.remaining += e.remaining; byOrganiser.set(k, o);
  }
  const KEYS = ["grossSales", "bookingFees", "organiserPaid", "expensesBilit", "bilitProfit", "remaining", "netSales", "refunds"] as const;
  const converted = fx.reportingCurrency ? (() => {
    const out: Record<string, number> = Object.fromEntries(KEYS.map((k) => [k, 0]));
    const missing = new Set<string>();
    for (const t of totals) for (const k of KEYS) { const v = convert(t[k], t.currency, fx); if (v === null) missing.add(t.currency); else out[k]! += v; }
    return { currency: fx.reportingCurrency, totals: out, missing: [...missing] };
  })() : null;
  return {
    totalEvents, activeEvents, totals, monthly, converted,
    profitByEvent: events.filter((e) => e.bilitProfit !== 0).sort((a, b) => b.bilitProfit - a.bilitProfit).map((e) => ({ eventId: e.eventId, eventName: e.eventName, currency: e.currency, profit: e.bilitProfit })),
    outstanding: [...byOrganiser.values()].filter((o) => o.remaining !== 0).sort((a, b) => b.remaining - a.remaining),
  };
}

/** Per month × currency: gross sales, booking fees, organiser payments, Bilit profit. */
export async function monthlySeries(orgId: string, mode: Mode, r: Range) {
  const range = sql`${r.from ? sql` and e.entry_date >= ${r.from}::date` : sql``}${r.to ? sql` and e.entry_date <= ${r.to}::date` : sql``}`;
  const [l, k] = await Promise.all([
    db.execute<{ month: string; currency: string; gross: string; paid: string; profit: string; expenses: string }>(sql`
      select to_char(e.entry_date, 'YYYY-MM') as month, e.currency,
        sum(case when a.system_key = 'ticket_sales' then l.credit - l.debit else 0 end)::text as gross,
        sum(case when a.system_key = 'organiser_payable' and e.source_type = 'organiser_payment' then l.debit - l.credit else 0 end)::text as paid,
        sum(case when a.type in ('REVENUE', 'EXPENSE') then l.credit - l.debit else 0 end)::text as profit,
        sum(case when e.source_type = 'event_expense' and a.system_key = 'bank' then l.credit - l.debit else 0 end)::text as expenses
      from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} ${range}
      group by 1, 2 order by 1, 2`),
    db.execute<{ month: string; currency: string; k: string }>(sql`
      select to_char(e.entry_date, 'YYYY-MM') as month, bt.currency, coalesce(sum(bt.commission_amount), 0)::text as k
      from stripe_balance_transactions bt join acct_journal_entries e on e.id = bt.posted_entry_id
      where bt.organisation_id = ${orgId} and bt.livemode = ${isLive(mode)} and bt.match_status = 'MATCHED' ${range}
      group by 1, 2`),
  ]);
  const km = new Map(k.rows.map((x) => [`${x.month}|${x.currency}`, n(x.k)]));
  return l.rows.map((x) => ({ month: x.month, currency: x.currency, grossSales: n(x.gross), bookingFees: km.get(`${x.month}|${x.currency}`) ?? 0, organiserPaid: n(x.paid), expenses: n(x.expenses), bilitProfit: n(x.profit) }));
}

// ---------- audit trail of one event ----------
/** Accounting audit entries that concern an event (the event itself, its agreements, payments and expenses). */
export async function eventAuditTrail(orgId: string, eventId: string, limit = 200) {
  const r = await db.execute<{ id: string; event_type: string; occurred_at: Date; metadata: Record<string, unknown>; user_name: string | null; user_email: string | null }>(sql`
    select a.id, a.event_type, a.occurred_at, a.metadata, u.name as user_name, u.email as user_email from audit_events a left join users u on u.id = a.user_id
    where a.organisation_id = ${orgId} and a.contract_id is null and a.event_type like 'accounting.%'
      and (a.metadata->>'entityId' = ${eventId} or a.metadata->>'eventId' = ${eventId} or a.metadata->'new'->>'eventId' = ${eventId} or a.metadata->'old'->>'eventId' = ${eventId})
    order by a.occurred_at desc limit ${limit}`);
  return r.rows.map((x) => ({ id: x.id, type: x.event_type.replace(/^accounting\./, ""), at: x.occurred_at, userName: x.user_name ?? x.user_email, metadata: x.metadata }));
}
