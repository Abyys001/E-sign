import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { currencyExponent } from "@/lib/money";
import { getAcctSettings, isLive, type Mode } from "./core";
import { expenseSpike, getMonitorSettings, monitorAlerts } from "./monitor";
import { booksOverview } from "./books";
import { eventFinancials, organiserBalances, settlementStatus, type Range, type SettlementStatus } from "./finance";
import { gatewayFor, getStripeAccount, safeStripeError } from "./stripe-gateway";
import { wiseRates } from "./wise";
import { xeRates } from "./xe";

/**
 * Financial position: what Bilit holds, what it owes, what it is owed and what is left, per currency.
 *
 * Every figure is traced to a source and carries a status:
 *   VERIFIED  – read live from the money provider (Stripe balance API, Wise balances synced within 2 h) or from posted ledger entries
 *   STALE     – real data, but the last sync is old
 *   REVIEW    – posted, but the books cannot say who the money belongs to (e.g. unallocated receipts) or it rests on an assumption
 * Cash is never inflated by receivables, inventory or money in transit; liabilities are taken once (organiser balances from
 * the settlement calculation, everything else from its own ledger account) and cross-checked against the ledger.
 *
 * Remaining after settlements = verified cash − organiser balances owed − other unpaid liabilities.
 */

export type Status = "VERIFIED" | "STALE" | "REVIEW" | "UNVERIFIED";
export type CashSource = { id: string; provider: "stripe" | "wise" | "ledger"; label: string; currency: string; amount: number; availableNow: boolean; status: Status; source: string; asOf: string | null; note?: string };
export type LiabilityKey = "organisers" | "accounts_payable" | "wages" | "employee_reimbursements" | "profit_share" | "unallocated";
export type Liability = { key: LiabilityKey; currency: string; amount: number; dueNow: number; status: Status; accountCodes: string[] };
export type Receivable = { key: "organisers" | "vat_input"; currency: string; amount: number; status: Status };
export type CurrencyPosition = {
  currency: string;
  cash: number; cashAvailableNow: number; cashRestricted: number;
  liabilities: number; liabilitiesDueNow: number; organisersOwed: number; organisersDueNow: number; otherLiabilities: number;
  receivables: number;
  remaining: number; remainingNow: number; shortfall: number; shortfallNow: number;
  status: Status;
};
export type Alert = { id: string; severity: "critical" | "warning" | "info"; title: string; detail: string; currency?: string; amount?: number; href?: string };

const n = (v: unknown) => Number(v ?? 0);
const CASH_CODES = ["1000", "1010", "1020", "1030"];
/** Cash-flow views: the Stripe balance (reconciled to the Stripe API) and the bank side of the books (only as complete as the bookkeeping). */
const FLOW_GROUPS = [{ key: "stripe", codes: ["1000"], status: "VERIFIED" as Status }, { key: "bank", codes: ["1010", "1020", "1030"], status: "REVIEW" as Status }];
const DIRECT_COST_CODES = new Set(["5000", "5010", "5100", "5200", "6900"]);
const LIAB: Array<{ key: LiabilityKey; codes: string[]; dueNow: boolean; status: Status }> = [
  { key: "accounts_payable", codes: ["2100"], dueNow: true, status: "VERIFIED" },
  { key: "wages", codes: ["2200", "2210"], dueNow: true, status: "VERIFIED" },
  { key: "employee_reimbursements", codes: ["2300"], dueNow: true, status: "VERIFIED" },
  { key: "profit_share", codes: ["2400"], dueNow: true, status: "VERIFIED" },
  // Money received that no event claims yet: kept back until someone says whose it is.
  { key: "unallocated", codes: ["2900"], dueNow: false, status: "REVIEW" },
];

// ---------- pure calculations (unit-tested) ----------

/**
 * Split one organiser's balance into "due now" (events that already took place) and "due later" (future events).
 * Payments made at organiser level (no event) are applied oldest event first, as are credits from events where the
 * organiser owes Bilit. The two parts always add up to the organiser's balance (or 0 when the organiser owes us).
 */
export function splitDueNow(events: Array<{ startsOn: string | null; remaining: number }>, unallocatedPaid: number, today: string): { dueNow: number; later: number } {
  let dueNow = 0, later = 0;
  for (const x of dueSchedule(events, unallocatedPaid)) if (!x.startsOn || x.startsOn <= today) dueNow += x.amount; else later += x.amount;
  return { dueNow, later };
}

/** What is still owed per event date once organiser-level payments and credits are applied oldest event first (feeds the cash forecast). */
export function dueSchedule(events: Array<{ startsOn: string | null; remaining: number }>, unallocatedPaid: number): Array<{ startsOn: string | null; amount: number }> {
  let pool = unallocatedPaid + events.reduce((s, e) => s + Math.max(0, -e.remaining), 0);
  const out: Array<{ startsOn: string | null; amount: number }> = [];
  const owed = events.filter((e) => e.remaining > 0).sort((a, b) => (a.startsOn ?? "").localeCompare(b.startsOn ?? ""));
  for (const e of owed) {
    const used = Math.min(pool, e.remaining);
    pool -= used;
    if (e.remaining - used > 0) out.push({ startsOn: e.startsOn, amount: e.remaining - used });
  }
  return out;
}

/** Combine cash, liabilities and receivables of one currency. Receivables are shown but never counted as cash. */
export function currencyPosition(currency: string, cash: CashSource[], liabilities: Liability[], receivables: Receivable[]): CurrencyPosition {
  const c = cash.filter((x) => x.currency === currency), l = liabilities.filter((x) => x.currency === currency);
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  const total = sum(c, (x) => x.amount), now = sum(c.filter((x) => x.availableNow), (x) => x.amount);
  const liab = sum(l, (x) => x.amount), liabNow = sum(l, (x) => x.dueNow);
  const org = l.find((x) => x.key === "organisers");
  const statuses = [...c.map((x) => x.status), ...l.map((x) => x.status)];
  return {
    currency, cash: total, cashAvailableNow: now, cashRestricted: total - now,
    liabilities: liab, liabilitiesDueNow: liabNow, organisersOwed: org?.amount ?? 0, organisersDueNow: org?.dueNow ?? 0, otherLiabilities: liab - (org?.amount ?? 0),
    receivables: sum(receivables.filter((x) => x.currency === currency), (x) => x.amount),
    remaining: total - liab, remainingNow: now - liabNow, shortfall: Math.max(0, liab - total), shortfallNow: Math.max(0, liabNow - now),
    status: statuses.includes("UNVERIFIED") ? "UNVERIFIED" : statuses.includes("STALE") ? "STALE" : statuses.includes("REVIEW") ? "REVIEW" : "VERIFIED",
  };
}

export type PaymentRow = { id: string; organiserId: string; organiserName: string; amount: number; currency: string; paymentDate: string; reference: string | null; method: string };
export type DuplicateFinding = { kind: "SAME_REFERENCE" | "SAME_AMOUNT_DAYS" | "PAYOUT_TO_OWN_ACCOUNT"; paymentIds: string[]; organiserName: string; amount: number; currency: string; detail: string; distinctRefs?: boolean };

/**
 * Possible double-counted organiser payments (PAID only):
 *  - the same bank / payout reference used by two payments;
 *  - same organiser, currency and amount within 3 days;
 *  - a Stripe payout recorded as an organiser payment although it landed in Bilit's own Wise (then it only moved Bilit's money).
 */
export function findDuplicatePayments(payments: PaymentRow[], ownAccountPayouts: Set<string>): DuplicateFinding[] {
  const out: DuplicateFinding[] = [];
  const byRef = new Map<string, PaymentRow[]>();
  for (const p of payments) {
    const ref = p.reference?.trim().toLowerCase();
    if (ref && ref.length >= 6) byRef.set(ref, [...(byRef.get(ref) ?? []), p]);
  }
  for (const [ref, ps] of byRef) if (ps.length > 1) out.push({ kind: "SAME_REFERENCE", paymentIds: ps.map((p) => p.id), organiserName: ps[0]!.organiserName, amount: ps[0]!.amount, currency: ps[0]!.currency, detail: `Reference ${ref} is used by ${ps.length} payments` });
  const sorted = [...payments].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
  const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i]!, b = sorted[j]!;
    if (days(a.paymentDate, b.paymentDate) > 3) break;
    if (a.organiserId === b.organiserId && a.currency === b.currency && a.amount === b.amount && !out.some((f) => f.paymentIds.includes(a.id) && f.paymentIds.includes(b.id))) {
      const distinctRefs = !!a.reference?.trim() && !!b.reference?.trim() && a.reference.trim().toLowerCase() !== b.reference.trim().toLowerCase();
      out.push({ kind: "SAME_AMOUNT_DAYS", paymentIds: [a.id, b.id], organiserName: a.organiserName, amount: a.amount, currency: a.currency, distinctRefs, detail: `Two payments of the same amount on ${a.paymentDate} and ${b.paymentDate}${distinctRefs ? " with different references — probably two real payments, check once" : ""}` });
    }
  }
  for (const p of payments) if (p.reference && ownAccountPayouts.has(p.reference.trim())) out.push({ kind: "PAYOUT_TO_OWN_ACCOUNT", paymentIds: [p.id], organiserName: p.organiserName, amount: p.amount, currency: p.currency, detail: `Stripe payout ${p.reference} arrived in Bilit's own Wise account, so it is not a payment to the organiser` });
  return out;
}

export type CashEntry = { date: string; type: string; delta: number };
export type CashFlow = { currency: string; opening: number; inflows: number; outflows: number; closing: number; byType: Array<{ type: string; inflow: number; outflow: number }> };

/**
 * Cash movements of the books' cash accounts (Stripe balance, bank, payouts in transit, cash) for a period.
 * `delta` is the net change of all cash accounts in one journal entry, so moves between Bilit's own accounts
 * (a payout leaving Stripe for the bank) net to zero and are never counted as income or spending.
 */
export function cashFlow(currency: string, entries: CashEntry[], r: Range): CashFlow {
  let opening = 0, inflows = 0, outflows = 0;
  const by = new Map<string, { inflow: number; outflow: number }>();
  for (const e of entries) {
    if (r.to && e.date > r.to) continue;
    if (r.from && e.date < r.from) { opening += e.delta; continue; }
    if (e.delta === 0) continue;
    const t = by.get(e.type) ?? { inflow: 0, outflow: 0 };
    if (e.delta > 0) { inflows += e.delta; t.inflow += e.delta; } else { outflows -= e.delta; t.outflow -= e.delta; }
    by.set(e.type, t);
  }
  return { currency, opening, inflows, outflows, closing: opening + inflows - outflows, byType: [...by].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.inflow + b.outflow - (a.inflow + a.outflow)) };
}

/** Convert minor units with a "1 source = rate target" table; null when a rate is missing. */
export function convertMinor(minor: number, from: string, to: string, rates: Record<string, string>): number | null {
  if (from === to) return minor;
  const r = Number(rates[from]);
  if (!Number.isFinite(r) || r <= 0) return null;
  return Math.round(minor * r * 10 ** (currencyExponent(to) - currencyExponent(from)));
}

/**
 * Profit and loss of one currency from the books: revenue = ticket sales − organiser share + Bilit's fees and other revenue;
 * direct costs = Stripe fees (net of recharges), refunds, chargebacks, event costs and other event expenses; the rest of the
 * expense accounts are operating expenses (incl. profit share).
 */
export function profitOf(b: { currency: string; revenue: number; expenses: number; netProfit: number; lines: Array<{ code: string; name: string; type: string; amount: number }> }) {
  const direct = b.lines.filter((l) => l.type === "EXPENSE" && DIRECT_COST_CODES.has(l.code)).reduce((s, l) => s + l.amount, 0);
  const ticketSales = b.lines.find((l) => l.code === "4000")?.amount ?? 0;
  return { currency: b.currency, ticketSales, revenue: b.revenue, directCosts: direct, grossProfit: b.revenue - direct, operatingExpenses: b.expenses - direct, expenses: b.expenses, netProfit: b.netProfit, lines: b.lines };
}

// ---------- data gathering ----------

export async function financialPosition(orgId: string, mode: Mode, r: Range, opts: { live?: boolean } = {}) {
  const live = isLive(mode), today = new Date().toISOString().slice(0, 10), now = Date.now();
  const settings = await getAcctSettings(orgId);
  const alerts: Alert[] = [];

  const [ledger, cashEntries, orgBals, events, organisers, payments, wiseConn, wiseIns, wiseUnbooked, unmatched, review, books, monthlyExp, acc] = await Promise.all([
    db.execute<{ code: string; currency: string; bal: string }>(sql`
      select a.code, e.currency, sum(l.debit - l.credit)::text as bal from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${live} group by 1, 2`),
    // Reversed entries and their reversals cancel out; leaving both out keeps edits from showing as money in and out.
    db.execute<{ grp: string; currency: string; date: string; type: string; delta: string }>(sql`
      select case when a.code = '1000' then 'stripe' else 'bank' end as grp, e.currency, e.entry_date::text as date, e.entry_type as type, sum(l.debit - l.credit)::text as delta
      from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${live} and a.code in (${sql.join(CASH_CODES.map((c) => sql`${c}`), sql`, `)})
        and e.status <> 'REVERSED' and e.entry_type <> 'REVERSAL'
      group by e.id, 1, 2, 3, 4 order by 3`),
    organiserBalances(orgId, mode),
    eventFinancials(orgId, mode),
    db.select({ id: schema.acctOrganisers.id, name: schema.acctOrganisers.name }).from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, orgId)),
    db.execute<{ id: string; organiser_id: string; event_id: string | null; amount: string; currency: string; payment_date: string; bank_reference: string | null; method: string; status: string }>(sql`
      select id, organiser_id, event_id, amount::text, currency, payment_date::text, bank_reference, method, status from acct_organiser_payments where organisation_id = ${orgId} and livemode = ${live}`),
    db.select().from(schema.acctWiseConnections).where(eq(schema.acctWiseConnections.organisationId, orgId)),
    db.execute<{ payout: string }>(sql`select distinct stripe_payout_id as payout from acct_wise_transactions where organisation_id = ${orgId} and direction = 'IN' and stripe_payout_id is not null`),
    db.execute<{ currency: string; n: number; amount: string }>(sql`
      select coalesce(source_currency, currency) as currency, count(*)::int as n, sum(coalesce(source_amount, amount))::text as amount from acct_wise_transactions
      where organisation_id = ${orgId} and direction = 'OUT' and kind = 'TRANSFER' and status not in ('cancelled', 'bounced_back', 'funds_refunded', 'charged_back')
        and not ignored and organiser_payment_id is null and bill_id is null and partner_payment_id is null group by 1`),
    db.execute<{ reason: string | null; currency: string; n: number; amount: string }>(sql`
      select match_reason as reason, currency, count(*)::int as n, sum(amount)::text as amount from stripe_balance_transactions
      where organisation_id = ${orgId} and livemode = ${live} and kind = 'SALE' and match_status = 'UNMATCHED' group by 1, 2`),
    db.execute<{ currency: string; n: number; amount: string }>(sql`
      select currency, count(*)::int as n, sum(amount)::text as amount from stripe_balance_transactions where organisation_id = ${orgId} and livemode = ${live} and reconciliation_status = 'MANUAL_REVIEW' group by 1`),
    booksOverview(orgId, mode, r),
    db.execute<{ month: string; currency: string; amount: string }>(sql`
      select to_char(e.entry_date, 'YYYY-MM') as month, e.currency, sum(l.debit - l.credit)::text as amount from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${live} and a.type = 'EXPENSE' and a.code >= '6000' and a.code <> '6950' and e.entry_date >= (date_trunc('month', current_date) - interval '3 months') group by 1, 2`),
    getStripeAccount(orgId, mode),
  ]);
  const bal = (code: string, cur: string) => n(ledger.rows.find((x) => x.code === code && x.currency === cur)?.bal);
  const names = new Map(organisers.map((o) => [o.id, o.name]));

  // ----- cash: live provider balances -----
  const cash: CashSource[] = [];
  if (acc?.secretKeyEnc && opts.live !== false) {
    try {
      const b = await gatewayFor(acc).retrieveBalance();
      const at = new Date().toISOString();
      for (const x of b.available) if (x.amount) cash.push({ id: `stripe:available:${x.currency}`, provider: "stripe", label: "Stripe – available", currency: x.currency, amount: x.amount, availableNow: true, status: "VERIFIED", source: "Stripe balance API", asOf: at });
      for (const x of b.pending) if (x.amount) cash.push({ id: `stripe:pending:${x.currency}`, provider: "stripe", label: "Stripe – pending", currency: x.currency, amount: x.amount, availableNow: false, status: "VERIFIED", source: "Stripe balance API", asOf: at, note: "Collected but not yet released by Stripe" });
    } catch (e) {
      alerts.push({ id: "stripe-api", severity: "critical", title: "Stripe balance could not be read", detail: `${safeStripeError(e)} — showing the balance from the books instead (unverified).` });
      for (const row of ledger.rows.filter((x) => x.code === "1000" && n(x.bal) !== 0)) cash.push({ id: `ledger:1000:${row.currency}`, provider: "ledger", label: "Stripe (books)", currency: row.currency, amount: n(row.bal), availableNow: true, status: "UNVERIFIED", source: "Ledger account 1000", asOf: null });
    }
  } else if (!acc?.secretKeyEnc) alerts.push({ id: "stripe-missing", severity: "warning", title: "Stripe is not connected", detail: `No Stripe ${mode} account is connected, so Stripe cash is not included.` });

  const wc = wiseConn[0];
  if (wc?.profileId) {
    const ageH = wc.lastSyncAt ? (now - wc.lastSyncAt.getTime()) / 3_600_000 : Infinity;
    // Balances come with every sync; a failing statement download (lastError) does not make them wrong.
    const st: Status = ageH <= 2 ? "VERIFIED" : "STALE";
    const by = new Map<string, number>();
    for (const b of (wc.balances as Array<{ currency: string; amount: number }>) ?? []) by.set(b.currency, (by.get(b.currency) ?? 0) + b.amount);
    for (const [cur, amount] of by) if (amount) cash.push({ id: `wise:${cur}`, provider: "wise", label: "Wise", currency: cur, amount, availableNow: true, status: st, source: "Wise balances (synced)", asOf: wc.lastSyncAt?.toISOString() ?? null });
    if (st !== "VERIFIED") alerts.push({ id: "wise-stale", severity: "warning", title: "Wise balances are not current", detail: `Last Wise sync was ${Number.isFinite(ageH) ? `${Math.round(ageH)} hours` : "never"} ago${wc.lastError ? ` (${wc.lastError})` : ""}. Run a sync on the Wise page.`, href: "/accounting/wise" });
  } else if (live) alerts.push({ id: "wise-missing", severity: "info", title: "Wise is not connected", detail: "Bank money outside Stripe is not included." });

  // ----- organiser settlements -----
  const paymentRows = payments.rows;
  const eventPaid = new Map<string, number>(); // organiser|currency → paid against specific events
  for (const p of paymentRows) if (p.status === "PAID" && p.event_id) { const k = `${p.organiser_id}|${p.currency}`; eventPaid.set(k, (eventPaid.get(k) ?? 0) + n(p.amount)); }
  const settlements = orgBals.map((o) => {
    const evs = events.filter((e) => e.organiserId === o.organiserId && e.currency === o.currency);
    const unallocated = Math.max(0, o.organiserPaid - (eventPaid.get(`${o.organiserId}|${o.currency}`) ?? 0));
    const schedule = o.remaining > 0 ? dueSchedule(evs.map((e) => ({ startsOn: e.startsOn, remaining: e.remaining })), unallocated) : [];
    const split = o.remaining > 0 ? splitDueNow(evs.map((e) => ({ startsOn: e.startsOn, remaining: e.remaining })), unallocated, today) : { dueNow: 0, later: 0 };
    const last = paymentRows.filter((p) => p.status === "PAID" && p.organiser_id === o.organiserId && p.currency === o.currency).map((p) => p.payment_date).sort().at(-1) ?? null;
    return {
      organiserId: o.organiserId, organiserName: names.get(o.organiserId) ?? "—", currency: o.currency, events: evs.filter((e) => e.grossSales || e.organiserDue).length,
      grossSales: o.grossSales, refunds: o.refunds + o.chargebacks, netSales: o.netSales, bookingFees: o.bookingFees, feesRecharged: o.feesRecharged,
      organiserShare: o.organiserShare, deductions: o.deductions, expensesOrganiser: o.expensesOrganiser,
      due: o.organiserDue, paid: o.organiserPaid, pending: o.pendingPayments, remaining: o.remaining, dueNow: split.dueNow, dueLater: split.later, schedule,
      status: settlementStatus(o.organiserDue, o.organiserPaid) as SettlementStatus, lastPayment: last,
      eventsOwing: evs.filter((e) => e.remaining < 0).map((e) => ({ eventId: e.eventId, eventName: e.eventName, amount: -e.remaining })),
    };
  }).filter((s) => s.due || s.paid || s.grossSales).sort((a, b) => b.remaining - a.remaining);

  // ----- liabilities (each counted once) -----
  const currencies = new Set<string>([...cash.map((c) => c.currency), ...settlements.map((s) => s.currency), ...ledger.rows.filter((x) => n(x.bal) !== 0).map((x) => x.currency)]);
  const liabilities: Liability[] = [], receivables: Receivable[] = [];
  for (const cur of currencies) {
    const owed = settlements.filter((s) => s.currency === cur && s.remaining > 0);
    const amt = owed.reduce((s, x) => s + x.remaining, 0);
    if (amt) liabilities.push({ key: "organisers", currency: cur, amount: amt, dueNow: owed.reduce((s, x) => s + x.dueNow, 0), status: "VERIFIED", accountCodes: ["2000"] });
    for (const L of LIAB) {
      const a = -L.codes.reduce((s, c) => s + bal(c, cur), 0);
      if (a > 0) liabilities.push({ key: L.key, currency: cur, amount: a, dueNow: L.dueNow ? a : 0, status: L.status, accountCodes: L.codes });
    }
    const oweUs = settlements.filter((s) => s.currency === cur && s.remaining < 0).reduce((s, x) => s - x.remaining, 0);
    if (oweUs) receivables.push({ key: "organisers", currency: cur, amount: oweUs, status: "VERIFIED" });
    if (bal("1200", cur) > 0) receivables.push({ key: "vat_input", currency: cur, amount: bal("1200", cur), status: "VERIFIED" });
    // Cross-check: organiser payable in the books (2000, net of 1100) must equal the settlement calculation.
    const books2000 = -bal("2000", cur) - bal("1100", cur), calc = settlements.filter((s) => s.currency === cur).reduce((s, x) => s + x.remaining, 0);
    if (books2000 !== calc) alerts.push({ id: `org-recon-${cur}`, severity: "critical", title: `Organiser balances do not match the ledger (${cur.toUpperCase()})`, detail: `Ledger account 2000 says ${books2000 / 100}, organiser settlements add up to ${calc / 100}.`, currency: cur, amount: books2000 - calc });
  }

  const positions = [...currencies].sort().map((c) => currencyPosition(c, cash, liabilities, receivables)).filter((p) => p.cash || p.liabilities || p.receivables);

  // ----- books vs real money -----
  const reconciliation = positions.map((p) => {
    const stripeReal = cash.filter((c) => c.provider === "stripe" && c.currency === p.currency).reduce((s, c) => s + c.amount, 0);
    const wiseReal = cash.filter((c) => c.provider === "wise" && c.currency === p.currency).reduce((s, c) => s + c.amount, 0);
    return { currency: p.currency, stripeBooks: bal("1000", p.currency), stripeReal, bankBooks: bal("1010", p.currency) + bal("1030", p.currency), inTransitBooks: bal("1020", p.currency), wiseReal };
  });
  for (const x of reconciliation) {
    if (cash.some((c) => c.provider === "stripe") && x.stripeBooks !== x.stripeReal) alerts.push({ id: `stripe-recon-${x.currency}`, severity: "critical", title: `Stripe balance differs from the books (${x.currency.toUpperCase()})`, detail: `Stripe says ${x.stripeReal / 100}, the books say ${x.stripeBooks / 100}. Run a Stripe sync, then check Reconciliation.`, currency: x.currency, amount: x.stripeReal - x.stripeBooks, href: "/accounting/reconciliation" });
    if (x.bankBooks + x.inTransitBooks < 0) alerts.push({ id: `bank-neg-${x.currency}`, severity: "warning", title: `Bank account in the books is negative (${x.currency.toUpperCase()})`, detail: `The books show more paid out of the bank than came in (${(x.bankBooks + x.inTransitBooks) / 100}). Money that funded those payments (e.g. a currency conversion in Wise) is not booked. Real cash above comes from Stripe and Wise directly, so it is not affected.`, currency: x.currency, amount: x.bankBooks + x.inTransitBooks });
  }

  // ----- shortfalls -----
  for (const p of positions) {
    if (p.shortfall > 0) alerts.push({ id: `short-${p.currency}`, severity: "critical", title: `Not enough ${p.currency.toUpperCase()} to pay everything owed`, detail: `Owed ${p.liabilities / 100}, held ${p.cash / 100}. Short by ${p.shortfall / 100} ${p.currency.toUpperCase()} unless covered from another currency.`, currency: p.currency, amount: p.shortfall });
    else if (p.shortfallNow > 0) alerts.push({ id: `short-now-${p.currency}`, severity: "warning", title: `Not enough available ${p.currency.toUpperCase()} for payments due now`, detail: `Due now ${p.liabilitiesDueNow / 100}, available now ${p.cashAvailableNow / 100} (the rest is still pending in Stripe).`, currency: p.currency, amount: p.shortfallNow });
  }

  // ----- duplicates / data quality -----
  const paid: PaymentRow[] = paymentRows.filter((p) => p.status === "PAID").map((p) => ({ id: p.id, organiserId: p.organiser_id, organiserName: names.get(p.organiser_id) ?? "—", amount: n(p.amount), currency: p.currency, paymentDate: p.payment_date, reference: p.bank_reference, method: p.method }));
  const duplicates = findDuplicatePayments(paid, new Set(wiseIns.rows.map((x) => x.payout)));
  for (const d of duplicates) alerts.push({ id: `dup-${d.paymentIds.join("-")}`, severity: d.kind !== "SAME_AMOUNT_DAYS" ? "critical" : d.distinctRefs ? "info" : "warning", title: `Possible duplicate payment — ${d.organiserName}`, detail: d.detail, currency: d.currency, amount: d.amount, href: "/accounting/payments" });
  for (const u of unmatched.rows) alerts.push({ id: `unmatched-${u.reason}-${u.currency}`, severity: "warning", title: u.reason === "CODE_NOT_FOUND" ? "Stripe sales for events that are not set up" : "Stripe payments without an event", detail: `${u.n} sale(s) not assigned to an event — the organiser share is not in the balances above.`, currency: u.currency, amount: n(u.amount), href: "/accounting/transactions?status=UNMATCHED" });
  for (const v of review.rows) alerts.push({ id: `review-${v.currency}`, severity: "warning", title: "Stripe activity waiting for review", detail: `${v.n} transaction(s) (e.g. top-ups) are not classified yet.`, currency: v.currency, amount: n(v.amount), href: "/accounting/reconciliation" });
  for (const w of wiseUnbooked.rows) alerts.push({ id: `wise-unbooked-${w.currency}`, severity: "info", title: "Wise transfers not in the books", detail: `${w.n} outgoing Wise transfer(s) are not linked to an organiser payment, bill or partner payment.`, currency: w.currency, amount: n(w.amount), href: "/accounting/wise" });
  for (const s of settlements) if (s.remaining < 0) alerts.push({ id: `owes-${s.organiserId}-${s.currency}`, severity: "info", title: `${s.organiserName} owes Bilit`, detail: "Booking fees refunded to customers that the organiser has to cover.", currency: s.currency, amount: -s.remaining, href: `/accounting/organisers/${s.organiserId}` });
  for (const b of books) if (b.overdueBills > 0) alerts.push({ id: `bills-${b.currency}`, severity: "critical", title: "Overdue supplier invoices", detail: `${b.overdueCount} invoice(s) are past their due date.`, currency: b.currency, amount: b.overdueBills, href: "/accounting/books/invoices" });
  // Unusually high running costs: this month above N× the average of the previous months that have data (up to 3).
  const thisMonth = today.slice(0, 7);
  const monitor = await getMonitorSettings(orgId);
  for (const cur of new Set(monthlyExp.rows.map((x) => x.currency))) {
    const spike = expenseSpike(monthlyExp.rows.filter((x) => x.currency === cur).map((x) => ({ month: x.month, amount: n(x.amount) })), thisMonth, monitor.expenseSpikeX);
    if (spike) alerts.push({ id: `exp-${cur}`, severity: "warning", title: `Running costs are high this month (${cur.toUpperCase()})`, detail: `This month ${spike.current / 100} vs a recent monthly average of ${Math.round(spike.average) / 100} (alert above ${monitor.expenseSpikeX}×).`, currency: cur, amount: spike.current, href: "/accounting/books" });
  }
  // Coded checks: refund rate, Stripe fee %, margin, duplicate supplier invoices, webhook health (thresholds in Finance settings).
  alerts.push(...await monitorAlerts(orgId, mode, events, monitor, acc ? { id: acc.id, lastWebhookAt: acc.lastWebhookAt } : null));
  const balanceTransfers = await db.execute<{ currency: string; amount: string }>(sql`
    select e.currency, sum(l.debit - l.credit)::text as amount from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${live} and e.entry_type = 'PAYOUT_PAID' and e.description ilike '%balance tra%' and a.code = '1010' and e.entry_date >= current_date - 60 group by 1`);
  for (const b of balanceTransfers.rows) alerts.push({ id: `fa-${b.currency}`, severity: "warning", title: "Money moved to the Stripe financial account is not visible", detail: `${n(b.amount) / 100} ${b.currency.toUpperCase()} went from Stripe to the Stripe 'balance transfer' wallet in the last 60 days. The Stripe key cannot read that wallet, so whatever is still in it is NOT counted as cash. Check the wallet in the Stripe dashboard.`, currency: b.currency, amount: n(b.amount) });

  // ----- profit (period) -----
  const profit = books.map(profitOf);

  // ----- cash flow (books) -----
  const flows = FLOW_GROUPS.flatMap((g) => [...new Set(cashEntries.rows.filter((x) => x.grp === g.key).map((x) => x.currency))].sort()
    .map((cur) => ({ account: g.key, status: g.status, ...cashFlow(cur, cashEntries.rows.filter((x) => x.grp === g.key && x.currency === cur).map((x) => ({ date: x.date, type: x.type, delta: n(x.delta) })), r) })));

  // ----- one total in the reporting currency (indicative) -----
  const target = settings.reportingCurrency ?? "gbp";
  let fx: { currency: string; rates: Record<string, string>; source: string; at: string | null } | null = null;
  const needed = [...new Set(positions.map((p) => p.currency))];
  // Rate source, best first: XE (when connected), rates typed in Finance settings, Wise's live rate.
  const covers = (r: Record<string, string>) => needed.every((c) => c === target || Number(r[c]) > 0);
  const xe = opts.live !== false ? await xeRates(orgId, target, needed) : null;
  if (xe && covers(xe.rates)) fx = { currency: target, rates: xe.rates, source: xe.source, at: xe.at };
  else if (settings.reportingCurrency && covers(settings.fxRates)) fx = { currency: target, rates: settings.fxRates, source: "Finance settings", at: null };
  else if (opts.live !== false) { const w = await wiseRates(orgId, target, needed); if (w) fx = { currency: target, rates: w.rates, source: "Wise live mid-market rate", at: w.at }; }
  if (xe?.stale) alerts.push({ id: "xe-stale", severity: "info", title: "XE could not be reached", detail: `Using the last XE rates from ${xe.at.slice(0, 16).replace("T", " ")} UTC.`, href: "/accounting/settings#xe" });
  const consolidated = fx ? (() => {
    const k = ["cash", "cashAvailableNow", "liabilities", "liabilitiesDueNow", "organisersOwed", "receivables", "remaining"] as const;
    const out = Object.fromEntries(k.map((x) => [x, 0])) as Record<(typeof k)[number], number>;
    const missing: string[] = [];
    for (const p of positions) for (const x of k) { const v = convertMinor(p[x], p.currency, fx!.currency, fx!.rates); if (v === null) { if (!missing.includes(p.currency)) missing.push(p.currency); } else out[x] += v; }
    const conv = (f: (p: (typeof profit)[number]) => number) => profit.reduce((s, p) => s + (convertMinor(f(p), p.currency, fx!.currency, fx!.rates) ?? 0), 0);
    return { ...fx!, totals: { ...out, shortfall: Math.max(0, out.liabilities - out.cash), netProfit: conv((p) => p.netProfit), revenue: conv((p) => p.revenue), ticketSales: conv((p) => p.ticketSales) }, missing };
  })() : null;
  if (!fx && positions.length > 1) alerts.push({ id: "fx", severity: "info", title: "No exchange rates", detail: "Set a reporting currency and rates in Finance settings to see one combined total.", href: "/accounting/settings" });

  const order = { critical: 0, warning: 1, info: 2 } as const;
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    asOf: new Date().toISOString(), mode, range: r, positions, cash, liabilities, receivables, settlements, profit, cashFlow: flows, reconciliation, duplicates, consolidated, alerts,
    inventory: { applicable: false, reason: "Bilit sells event tickets as an agent and holds no stock. The system has no products or stock records, so inventory value is 0 and not part of cash or profit." },
  };
}

/** Ledger lines behind one figure (an account in one currency), newest first. */
export async function accountLines(orgId: string, mode: Mode, codes: string[], currency: string, r: Range, f: { organiserId?: string } = {}) {
  const rows = await db.execute<{ id: string; seq: number; date: string; type: string; description: string; reference: string | null; debit: string; credit: string; code: string; event_id: string | null; organiser_id: string | null; status: string }>(sql`
    select e.id, e.seq, e.entry_date::text as date, e.entry_type as type, e.description, e.reference, l.debit::text, l.credit::text, a.code, l.event_id, l.organiser_id, e.status
    from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and e.currency = ${currency} and a.code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
      ${r.from ? sql` and e.entry_date >= ${r.from}::date` : sql``} ${r.to ? sql` and e.entry_date <= ${r.to}::date` : sql``}
      ${f.organiserId ? sql` and l.organiser_id = ${f.organiserId}` : sql``}
    order by e.entry_date desc, e.seq desc limit 1000`);
  return rows.rows.map((x) => ({ entryId: x.id, seq: x.seq, date: x.date, type: x.type, description: x.description, reference: x.reference, debit: n(x.debit), credit: n(x.credit), code: x.code, eventId: x.event_id, organiserId: x.organiser_id, status: x.status }));
}

/** Organiser payments (incl. voided, for the audit trail) behind a settlement row. */
export async function settlementPayments(orgId: string, mode: Mode, organiserId: string, currency: string) {
  const p = schema.acctOrganiserPayments;
  return db.select({ id: p.id, date: p.paymentDate, amount: p.amount, currency: p.currency, method: p.method, reference: p.bankReference, status: p.status, eventId: p.eventId, eventName: schema.acctEvents.name, voidReason: p.voidReason, notes: p.notes })
    .from(p).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, p.eventId))
    .where(and(eq(p.organisationId, orgId), eq(p.livemode, isLive(mode)), eq(p.organiserId, organiserId), eq(p.currency, currency)))
    .orderBy(sql`${p.paymentDate} desc`);
}
