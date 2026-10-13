import { sql } from "drizzle-orm";
import { db } from "@/db";
import { isLive, type Mode } from "./core";
import { getMonitorSettings } from "./monitor";
import { convertMinor, financialPosition } from "./position";

/**
 * Cash-flow forecast for the next 7 / 30 / 90 days, per currency. An ESTIMATE built only from records already in the books:
 *   start      cash available now (Stripe available + Wise), live from the providers — the same figure as the Financial Overview;
 *   + Stripe   money collected but still pending, released on each transaction's `available_on` date (Stripe's own schedule);
 *   − organisers  what is still owed per event, due on the event date + `organiserPayDays` (Finance settings);
 *   − bills    unpaid supplier invoices on their due date (overdue / no date = now);
 *   − other    wages, employee reimbursements and partner profit share already owed (now);
 *   − running costs (estimate, optional)  average monthly operating costs of the last 3 full months, spread per day.
 * Not included: future ticket sales, new refunds, FX conversions, unknown bills. Money no event claims yet (unallocated)
 * is held back, never spent. Nothing here is posted or paid.
 */
export type ForecastKind = "stripe_release" | "organisers" | "bills" | "wages" | "reimbursements" | "profit_share" | "running_costs";
export type ForecastFlow = { date: string; amount: number; kind: ForecastKind };
export type Horizon = { days: number; date: string; inflows: number; outflows: number; estimated: number; balance: number; free: number; byKind: Partial<Record<ForecastKind, number>> };
export type CurrencyForecast = { currency: string; start: number; held: number; pendingTotal: number; horizons: Horizon[]; low: { date: string; balance: number }; firstShort: string | null; beyond: number };

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Walk day by day from today; flows dated in the past fall on today. Pure; unit-tested. */
export function projectCash(a: { currency: string; today: string; start: number; held: number; flows: ForecastFlow[]; dailyCost: number; horizons: number[] }): CurrencyForecast {
  const max = Math.max(...a.horizons);
  const end = addDays(a.today, max);
  const at = (f: ForecastFlow) => (f.date < a.today ? a.today : f.date);
  const byDay = new Map<string, ForecastFlow[]>();
  for (const f of a.flows) if (at(f) <= end) byDay.set(at(f), [...(byDay.get(at(f)) ?? []), f]);
  let balance = a.start, inflows = 0, outflows = 0, estimated = 0;
  const kinds: Partial<Record<ForecastKind, number>> = {};
  const horizons: Horizon[] = [];
  let low = { date: a.today, balance: Infinity }, firstShort: string | null = null;
  for (let d = 0; d <= max; d++) {
    const day = addDays(a.today, d);
    for (const f of byDay.get(day) ?? []) { balance += f.amount; if (f.amount > 0) inflows += f.amount; else outflows -= f.amount; kinds[f.kind] = (kinds[f.kind] ?? 0) + f.amount; }
    if (d > 0 && a.dailyCost > 0) { const c = Math.round(a.dailyCost * d) - Math.round(a.dailyCost * (d - 1)); balance -= c; estimated += c; kinds.running_costs = (kinds.running_costs ?? 0) - c; }
    const free = balance - a.held;
    if (free < low.balance) low = { date: day, balance: free };
    if (free < 0 && !firstShort) firstShort = day;
    if (a.horizons.includes(d)) horizons.push({ days: d, date: day, inflows, outflows, estimated, balance, free, byKind: { ...kinds } });
  }
  const beyond = a.flows.filter((f) => at(f) > end).reduce((s, f) => s + f.amount, 0);
  return { currency: a.currency, start: a.start, held: a.held, pendingTotal: a.flows.filter((f) => f.kind === "stripe_release").reduce((s, f) => s + f.amount, 0), horizons, low, firstShort, beyond };
}

export async function cashForecast(orgId: string, mode: Mode) {
  const live = isLive(mode), today = new Date().toISOString().slice(0, 10), HORIZONS = [7, 30, 90];
  const [pos, s] = await Promise.all([financialPosition(orgId, mode, {}), getMonitorSettings(orgId)]);
  const [pending, bills, costs] = await Promise.all([
    db.execute<{ currency: string; day: string; amount: string }>(sql`
      select currency, (available_on at time zone 'UTC')::date::text as day, sum(net)::text as amount from stripe_balance_transactions
      where organisation_id = ${orgId} and livemode = ${live} and available_on > now() group by 1, 2`),
    db.execute<{ currency: string; day: string; amount: string }>(sql`
      select currency, coalesce(due_date, invoice_date)::text as day, sum(total_amount)::text as amount from acct_bills
      where organisation_id = ${orgId} and livemode = ${live} and status = 'UNPAID' group by 1, 2`),
    // Average monthly operating costs (accounts 6000+, excl. partner profit share, which is owed separately) of the last 3 full months.
    db.execute<{ currency: string; months: number; amount: string }>(sql`
      select e.currency, count(distinct to_char(e.entry_date, 'YYYY-MM'))::int as months, sum(l.debit - l.credit)::text as amount
      from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${live} and a.type = 'EXPENSE' and a.code >= '6000' and a.code <> '6950'
        and e.entry_date >= date_trunc('month', current_date) - interval '3 months' and e.entry_date < date_trunc('month', current_date) group by 1`),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  const currencies = pos.positions.map((p) => p.currency);
  const forecasts = currencies.map((cur) => {
    const p = pos.positions.find((x) => x.currency === cur)!;
    const flows: ForecastFlow[] = [];
    // Stripe pending, by release date; anything the API reports beyond the imported schedule is assumed released within 7 days.
    // Never release more than Stripe actually reports as pending (refunds can be netted against it).
    let left = p.cashRestricted;
    for (const x of pending.rows.filter((r) => r.currency === cur).sort((a, b) => a.day.localeCompare(b.day))) {
      const amt = Math.min(left, n(x.amount));
      if (amt > 0) { flows.push({ date: x.day, amount: amt, kind: "stripe_release" }); left -= amt; }
    }
    if (left > 0) flows.push({ date: addDays(today, 7), amount: left, kind: "stripe_release" });
    for (const st of pos.settlements.filter((x) => x.currency === cur && x.remaining > 0)) {
      // Organiser-level items (no event) make the per-event schedule differ from the balance: align it so the forecast owes
      // exactly what the Financial Overview says — extra is due now, any excess comes off the latest events first.
      const sched = st.schedule.map((d) => ({ ...d }));
      let diff = st.remaining - sched.reduce((a, d) => a + d.amount, 0);
      for (let i = sched.length - 1; diff < 0 && i >= 0; i--) { const cut = Math.min(sched[i]!.amount, -diff); sched[i]!.amount -= cut; diff += cut; }
      if (diff > 0) sched.unshift({ startsOn: null, amount: diff });
      for (const d of sched) if (d.amount > 0) flows.push({ date: d.startsOn ? addDays(d.startsOn, s.organiserPayDays) : today, amount: -d.amount, kind: "organisers" });
    }
    const billRows = bills.rows.filter((x) => x.currency === cur);
    for (const b of billRows) flows.push({ date: b.day, amount: -n(b.amount), kind: "bills" });
    for (const l of pos.liabilities.filter((x) => x.currency === cur)) {
      // Accounts payable beyond the unpaid bills (e.g. entered by hand) falls due now.
      if (l.key === "accounts_payable") { const extra = l.amount - billRows.reduce((a, x) => a + n(x.amount), 0); if (extra > 0) flows.push({ date: today, amount: -extra, kind: "bills" }); }
      if (l.key === "wages") flows.push({ date: today, amount: -l.amount, kind: "wages" });
      if (l.key === "employee_reimbursements") flows.push({ date: today, amount: -l.amount, kind: "reimbursements" });
      if (l.key === "profit_share") flows.push({ date: today, amount: -l.amount, kind: "profit_share" });
    }
    const held = pos.liabilities.filter((x) => x.currency === cur && x.key === "unallocated").reduce((a, x) => a + x.amount, 0);
    const c = costs.rows.find((x) => x.currency === cur);
    const monthly = c && c.months > 0 ? n(c.amount) / c.months : 0;
    return { ...projectCash({ currency: cur, today, start: p.cashAvailableNow, held, flows, dailyCost: s.forecastRunRate ? Math.max(0, monthly) / 30 : 0, horizons: HORIZONS }), monthlyCosts: Math.round(monthly) };
  });
  const fx = pos.consolidated;
  const consolidated = fx ? HORIZONS.map((days) => {
    let free = 0, balance = 0; const missing: string[] = [];
    for (const f of forecasts) { const h = f.horizons.find((x) => x.days === days)!; const a = convertMinor(h.free, f.currency, fx.currency, fx.rates), b = convertMinor(h.balance, f.currency, fx.currency, fx.rates); if (a === null || b === null) missing.push(f.currency); else { free += a; balance += b; } }
    return { days, free, balance, missing };
  }) : null;
  return {
    asOf: pos.asOf, mode, today, horizons: HORIZONS, forecasts, consolidated: fx && consolidated ? { currency: fx.currency, source: fx.source, rates: fx.rates, horizons: consolidated } : null,
    assumptions: { organiserPayDays: s.organiserPayDays, runRate: s.forecastRunRate },
  };
}
