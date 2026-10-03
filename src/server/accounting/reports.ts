import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { toDecimalString } from "@/lib/money";
import { ensureLedgerSetup, isLive, type Mode } from "./core";

/**
 * Reporting reads the ledger (journal lines) — never Stripe directly — so every figure is traceable to postings, and
 * reversals net out naturally. Amounts stay integer minor units and are always grouped by currency (never converted).
 */
export const UNRECONCILED = ["UNMATCHED", "PARTIAL", "DUPLICATE", "MANUAL_REVIEW", "ERROR"] as const;
type Range = { from?: string | null; to?: string | null };
const n = (v: unknown) => Number(v ?? 0);
const dateRange = (col: SQL, r: Range) => sql`${r.from ? sql` and ${col} >= ${r.from}::date` : sql``}${r.to ? sql` and ${col} <= ${r.to}::date` : sql``}`;

type Totals = Record<string, { d: number; c: number }>;
/** Debit/credit totals per currency × system account for lines matching `filter`. */
async function accountTotals(orgId: string, mode: Mode, filter: SQL) {
  const r = await db.execute<{ currency: string; key: string; type: string; d: string; c: string; pay: boolean }>(sql`
    select e.currency, a.system_key as key, a.type, (e.source_type = 'organiser_payment') as pay, sum(l.debit)::text as d, sum(l.credit)::text as c
    from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} ${filter}
    group by 1, 2, 3, 4`);
  const by = new Map<string, { totals: Totals; payPayable: { d: number; c: number }; revenue: number; expense: number }>();
  for (const row of r.rows) {
    const cur = by.get(row.currency) ?? { totals: {}, payPayable: { d: 0, c: 0 }, revenue: 0, expense: 0 };
    const k = row.key ?? `custom:${row.type}`;
    const t = (cur.totals[k] ??= { d: 0, c: 0 });
    t.d += n(row.d); t.c += n(row.c);
    if (row.key === "organiser_payable" && row.pay) { cur.payPayable.d += n(row.d); cur.payPayable.c += n(row.c); }
    if (row.type === "REVENUE") cur.revenue += n(row.c) - n(row.d);
    if (row.type === "EXPENSE") cur.expense += n(row.d) - n(row.c);
    by.set(row.currency, cur);
  }
  return by;
}
const cr = (t: Totals, k: string) => (t[k]?.c ?? 0) - (t[k]?.d ?? 0);
const dr = (t: Totals, k: string) => (t[k]?.d ?? 0) - (t[k]?.c ?? 0);

/** Commission booked on Stripe transactions (signed: refunds reverse it), by currency. */
async function commissionTotals(orgId: string, mode: Mode, filter: SQL) {
  const r = await db.execute<{ currency: string; k: string }>(sql`
    select bt.currency, coalesce(sum(bt.commission_amount), 0)::text as k from stripe_balance_transactions bt join acct_journal_entries e on e.id = bt.posted_entry_id
    where bt.organisation_id = ${orgId} and bt.livemode = ${isLive(mode)} and bt.match_status = 'MATCHED' ${filter} group by 1`);
  return new Map(r.rows.map((x) => [x.currency, n(x.k)]));
}

function figures(t: Totals, pay: { d: number; c: number }, revenue: number, expense: number, commission: number) {
  const gross = cr(t, "ticket_sales"), refunds = dr(t, "refunds"), chargebacks = dr(t, "chargebacks"), stripeFees = dr(t, "stripe_fees"), feesRecharged = cr(t, "stripe_fee_recharges");
  const payableAll = cr(t, "organiser_payable"), paid = pay.d - pay.c;
  return {
    grossSales: gross, refunds, chargebacks, netSales: gross - refunds - chargebacks, stripeFees, stripeFeesRecharged: feesRecharged, netStripeFees: stripeFees - feesRecharged,
    commission, eventFees: cr(t, "bilit_commission"), otherRevenue: cr(t, "other_revenue"), otherCosts: dr(t, "other_expenses"),
    bilitRevenue: commission + cr(t, "bilit_commission") + cr(t, "other_revenue"),
    organiserPayable: payableAll + paid, organiserPayments: paid, organiserOutstanding: payableAll,
    bilitProfit: revenue - expense,
  };
}

export async function dashboard(orgId: string, mode: Mode, r: Range) {
  await ensureLedgerSetup(db, orgId);
  const inRange = dateRange(sql`e.entry_date`, r);
  const [period, toDate, comm, unrec, lastSync] = await Promise.all([
    accountTotals(orgId, mode, inRange),
    accountTotals(orgId, mode, r.to ? sql` and e.entry_date <= ${r.to}::date` : sql``),
    commissionTotals(orgId, mode, inRange),
    db.execute<{ status: string; n: number }>(sql`select reconciliation_status as status, count(*)::int as n from stripe_balance_transactions where organisation_id = ${orgId} and livemode = ${isLive(mode)} ${dateRange(sql`(stripe_created_at at time zone 'UTC')::date`, r)} group by 1`),
    db.execute<{ at: Date | null }>(sql`select max(last_sync_at) as at from stripe_accounts where organisation_id = ${orgId} and livemode = ${isLive(mode)}`),
  ]);
  const currencies = [...new Set([...period.keys(), ...toDate.keys()])].sort();
  return {
    mode, range: r, lastSyncAt: lastSync.rows[0]?.at ?? null,
    reconciliation: Object.fromEntries(unrec.rows.map((x) => [x.status, x.n])),
    unreconciled: unrec.rows.filter((x) => (UNRECONCILED as readonly string[]).includes(x.status)).reduce((s, x) => s + x.n, 0),
    currencies: currencies.map((currency) => {
      const p = period.get(currency) ?? { totals: {}, payPayable: { d: 0, c: 0 }, revenue: 0, expense: 0 };
      const all = toDate.get(currency)?.totals ?? {};
      return { currency, ...figures(p.totals, p.payPayable, p.revenue, p.expense, comm.get(currency) ?? 0), organiserOutstanding: cr(all, "organiser_payable"), stripeBalance: dr(all, "stripe_balance"), payoutsInTransit: dr(all, "payouts_in_transit"), unallocated: cr(all, "unallocated_receipts"), suspense: cr(all, "unclassified") };
    }),
  };
}

/** Financial summary of one event (or organiser) from its tagged ledger lines. */
export async function dimensionSummary(orgId: string, mode: Mode, dim: { eventId?: string; organiserId?: string }, r: Range = {}) {
  const f = dim.eventId ? sql` and l.event_id = ${dim.eventId}` : sql` and l.organiser_id = ${dim.organiserId!}`;
  const bf = dim.eventId ? sql` and bt.event_id = ${dim.eventId}` : sql` and bt.organiser_id = ${dim.organiserId!}`;
  const [tot, comm] = await Promise.all([accountTotals(orgId, mode, sql`${f}${dateRange(sql`e.entry_date`, r)}`), commissionTotals(orgId, mode, sql`${bf}${dateRange(sql`e.entry_date`, r)}`)]);
  return [...tot.entries()].map(([currency, p]) => ({ currency, ...figures(p.totals, p.payPayable, p.revenue, p.expense, comm.get(currency) ?? 0) }));
}

/** Per-event profitability rows (one per event × currency). */
export async function eventProfitRows(orgId: string, mode: Mode, r: Range, page: { limit: number; offset: number }, organiserId?: string) {
  const res = await db.execute<Record<string, string | null>>(sql`
    with l as (
      select l.event_id, e.currency, a.system_key as key, a.type, (e.source_type = 'organiser_payment') as pay, sum(l.debit) as d, sum(l.credit) as c
      from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and l.event_id is not null ${dateRange(sql`e.entry_date`, r)} ${organiserId ? sql` and l.organiser_id = ${organiserId}` : sql``}
      group by 1, 2, 3, 4, 5),
    k as (select bt.event_id, bt.currency, sum(bt.commission_amount) as k from stripe_balance_transactions bt join acct_journal_entries e on e.id = bt.posted_entry_id
          where bt.organisation_id = ${orgId} and bt.livemode = ${isLive(mode)} and bt.match_status = 'MATCHED' ${dateRange(sql`e.entry_date`, r)} group by 1, 2)
    select ev.id as event_id, ev.name as event_name, ev.code as event_code, o.id as organiser_id, o.name as organiser_name, l.currency,
      sum(case when key = 'ticket_sales' then c - d else 0 end)::text as gross,
      sum(case when key = 'refunds' then d - c else 0 end)::text as refunds,
      sum(case when key = 'chargebacks' then d - c else 0 end)::text as chargebacks,
      sum(case when key = 'stripe_fees' then d - c else 0 end)::text as stripe_fees,
      sum(case when key = 'stripe_fee_recharges' then c - d else 0 end)::text as fees_recharged,
      sum(case when key = 'bilit_commission' then c - d else 0 end)::text as event_fees,
      sum(case when key = 'other_expenses' then d - c else 0 end)::text as other_costs,
      sum(case when key = 'organiser_payable' and not pay then c - d else 0 end)::text as organiser_payable,
      sum(case when key = 'organiser_payable' and pay then d - c else 0 end)::text as paid,
      sum(case when type in ('REVENUE', 'EXPENSE') then c - d else 0 end)::text as profit,
      coalesce(max(k.k), 0)::text as commission
    from l join acct_events ev on ev.id = l.event_id left join acct_organisers o on o.id = ev.organiser_id left join k on k.event_id = l.event_id and k.currency = l.currency
    group by ev.id, ev.name, ev.code, o.id, o.name, l.currency order by ev.name, l.currency limit ${page.limit} offset ${page.offset}`);
  return res.rows.map((x) => ({
    eventId: x.event_id, eventName: x.event_name, eventCode: x.event_code, organiserId: x.organiser_id, organiserName: x.organiser_name, currency: x.currency!,
    grossSales: n(x.gross), refunds: n(x.refunds), chargebacks: n(x.chargebacks), stripeFees: n(x.stripe_fees), stripeFeesRecharged: n(x.fees_recharged),
    commission: n(x.commission) + n(x.event_fees), otherCosts: n(x.other_costs), organiserPayable: n(x.organiser_payable), organiserPaid: n(x.paid), organiserOutstanding: n(x.organiser_payable) - n(x.paid), bilitProfit: n(x.profit),
  }));
}

/** Organiser statement: one row per ledger entry touching the organiser's payable, with a running balance. */
export async function organiserStatement(orgId: string, mode: Mode, organiserId: string, currency: string, r: Range, page: { limit: number; offset: number }) {
  const res = await db.execute<Record<string, string | null>>(sql`
    with x as (
      select e.id, e.seq, e.entry_date::text as date, e.entry_type, e.description, e.reference, ev.name as event_name, ev.code as event_code, e.source_type,
        sum(case when a.system_key = 'ticket_sales' then l.credit - l.debit else 0 end) as sales,
        sum(case when a.system_key in ('refunds', 'chargebacks') then l.debit - l.credit else 0 end) as refunds,
        sum(case when a.system_key = 'stripe_fee_recharges' then l.credit - l.debit else 0 end) as fees,
        sum(case when a.system_key = 'organiser_payable' and e.source_type = 'organiser_payment' then l.debit - l.credit else 0 end) as payments,
        sum(case when a.system_key = 'organiser_payable' then l.credit - l.debit else 0 end) as change
      from acct_journal_entries e join acct_journal_lines l on l.entry_id = e.id join acct_accounts a on a.id = l.account_id left join acct_events ev on ev.id = e.event_id
      where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and e.currency = ${currency} and l.organiser_id = ${organiserId}
      group by e.id, e.seq, e.entry_date, e.entry_type, e.description, e.reference, ev.name, ev.code, e.source_type
      having sum(case when a.system_key = 'organiser_payable' then 1 else 0 end) > 0),
    y as (select x.*, sum(change) over (order by date, seq) as balance from x)
    select y.*, coalesce(bt.commission_amount, 0) as commission, ch.customer_name, coalesce(substring(ch.description from '^Order \(([^)]+)\)'), ch.payment_intent_id) as order_ref from y
      left join stripe_balance_transactions bt on bt.posted_entry_id = y.id
      left join stripe_charges ch on ch.stripe_account_ref = bt.stripe_account_ref and ch.charge_id = bt.charge_id
    where true ${dateRange(sql`y.date::date`, r)} order by y.date, y.seq limit ${page.limit} offset ${page.offset}`);
  const opening = r.from ? await db.execute<{ b: string | null }>(sql`
    select sum(l.credit - l.debit)::text as b from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and e.currency = ${currency} and l.organiser_id = ${organiserId} and a.system_key = 'organiser_payable' and e.entry_date < ${r.from}::date`) : null;
  return {
    openingBalance: n(opening?.rows[0]?.b),
    rows: res.rows.map((x) => ({ entryId: x.id, date: x.date, entryType: x.entry_type, description: x.description, reference: x.reference, eventName: x.event_name, eventCode: x.event_code, order: x.order_ref, customer: x.customer_name, sales: n(x.sales), refunds: n(x.refunds), fees: n(x.fees), commission: n(x.commission), payments: n(x.payments), change: n(x.change), balance: n(x.balance) })),
  };
}

export const SALES_FILTERS = ["eventId", "organiserId", "status"] as const;
/** Sales report: one row per Stripe sale with its refunds/disputes folded in (settlement currency amounts). */
export async function salesRows(orgId: string, mode: Mode, r: Range, page: { limit: number; offset: number }, f: { eventId?: string; organiserId?: string; status?: string } = {}) {
  const res = await db.execute<Record<string, string | null>>(sql`
    select s.id, s.stripe_created_at, ev.name as event_name, coalesce(ev.code, s.event_code) as event_code, o.name as organiser_name, ch.payment_intent_id, s.charge_id, s.balance_transaction_id,
      s.amount::text as gross, s.fee::text as fee, s.net::text as net, s.currency, s.reconciliation_status, ch.status as charge_status, ch.customer_name, ch.customer_email, s.commission_amount::text as commission, s.organiser_amount::text as organiser_amount,
      coalesce(d.refunded, 0)::text as refunded, coalesce(d.chargeback, 0)::text as chargeback, coalesce(d.fee, 0)::text as dep_fee, coalesce(d.net, 0)::text as dep_net, coalesce(d.commission, 0)::text as dep_commission
    from stripe_balance_transactions s
    left join stripe_charges ch on ch.stripe_account_ref = s.stripe_account_ref and ch.charge_id = s.charge_id
    left join acct_events ev on ev.id = s.event_id left join acct_organisers o on o.id = s.organiser_id
    left join lateral (select sum(case when b.kind = 'REFUND' then -b.amount else 0 end) as refunded, sum(case when b.kind in ('DISPUTE','DISPUTE_REVERSAL') then -b.amount else 0 end) as chargeback,
        sum(b.fee) as fee, sum(b.net) as net, sum(coalesce(b.commission_amount, 0)) as commission
      from stripe_balance_transactions b where b.stripe_account_ref = s.stripe_account_ref and b.charge_id = s.charge_id and b.kind <> 'SALE') d on true
    where s.organisation_id = ${orgId} and s.livemode = ${isLive(mode)} and s.kind = 'SALE' ${dateRange(sql`(s.stripe_created_at at time zone 'UTC')::date`, r)}
      ${f.eventId ? sql` and s.event_id = ${f.eventId}` : sql``} ${f.organiserId ? sql` and s.organiser_id = ${f.organiserId}` : sql``} ${f.status ? sql` and s.reconciliation_status = ${f.status}` : sql``}
    order by s.stripe_created_at desc, s.id limit ${page.limit} offset ${page.offset}`);
  return res.rows.map((x) => ({
    id: x.id, date: x.stripe_created_at, eventName: x.event_name, eventCode: x.event_code, organiserName: x.organiser_name, order: x.payment_intent_id, stripePayment: x.charge_id, balanceTransaction: x.balance_transaction_id,
    customerName: x.customer_name, customerEmail: x.customer_email, currency: x.currency!, gross: n(x.gross), refunded: n(x.refunded), chargeback: n(x.chargeback), netGross: n(x.gross) - n(x.refunded) - n(x.chargeback),
    stripeFee: n(x.fee) + n(x.dep_fee), net: n(x.net) + n(x.dep_net), commission: n(x.commission) + n(x.dep_commission), status: x.reconciliation_status, chargeStatus: x.charge_status,
  }));
}

/** Trial balance per currency and account as of a date. Debits always equal credits (enforced at posting). */
export async function trialBalance(orgId: string, mode: Mode, to?: string | null) {
  const r = await db.execute<{ id: string; code: string; name: string; type: string; currency: string; d: string; c: string }>(sql`
    select a.id, a.code, a.name, a.type, e.currency, sum(l.debit)::text as d, sum(l.credit)::text as c
    from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} ${to ? sql` and e.entry_date <= ${to}::date` : sql``}
    group by a.id, a.code, a.name, a.type, e.currency order by e.currency, a.code`);
  return r.rows.map((x) => ({ accountId: x.id, code: x.code, name: x.name, type: x.type, currency: x.currency, debit: n(x.d), credit: n(x.c), balance: n(x.d) - n(x.c) }));
}

// ---------- CSV ----------
/** CSV cell: plain numbers (incl. negatives) stay numeric; text that looks like a formula is neutralised. */
export const csvValue = (v: unknown) => {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
};
export type CsvColumn<T> = { header: string; value: (row: T) => unknown; money?: (row: T) => string };
export function csvRows<T>(cols: CsvColumn<T>[], rows: T[]) {
  return rows.map((r) => cols.map((c) => csvValue(c.money ? toDecimalString(Number(c.value(r) ?? 0), c.money(r)) : c.value(r))).join(",")).join("\r\n");
}

/** Stream a large CSV page by page so millions of rows never sit in memory or in the browser. */
export function csvStream<T>(cols: CsvColumn<T>[], fetchPage: (page: number) => Promise<{ rows: T[]; more: boolean }>, maxPages = 500) {
  let page = 0, done = false;
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(`\uFEFF${cols.map((x) => csvValue(x.header)).join(",")}\r\n`)); },
    async pull(c) {
      if (done) return;
      const { rows, more } = await fetchPage(page++);
      if (rows.length) c.enqueue(enc.encode(`${csvRows(cols, rows)}\r\n`));
      if (!more || page >= maxPages) { done = true; c.close(); }
    },
  });
}
/** Adapter for offset-paginated sources. */
export const PAGE = 2000;
export const paged = <T,>(fn: (limit: number, offset: number) => Promise<T[]>) => async (page: number) => { const rows = await fn(PAGE, page * PAGE); return { rows, more: rows.length === PAGE }; };
