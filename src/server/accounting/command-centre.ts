import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { isLive, type Mode } from "./core";
import { organiserBalances } from "./finance";
import { getStripeAccount, stripeAccountView } from "./stripe-gateway";

/**
 * Read-only data for the finance dashboard ("command centre"): a time series of the same ledger accounts the dashboard
 * KPIs use, and integration status + review counts for the alert panel. Nothing here writes or recalculates — every
 * figure comes straight from postings or from rows the importer already stored.
 */
type Range = { from?: string | null; to?: string | null };
export type Grain = "day" | "week" | "month" | "year";
const n = (v: unknown) => Number(v ?? 0);

/**
 * Per period × currency, from the ledger: gross ticket sales (4000 credit), refunds, chargebacks, Stripe fees (gross) and
 * fees recharged to organisers. `net` = gross − refunds − chargebacks − Stripe fees: the money actually collected.
 */
export async function dashboardSeries(orgId: string, mode: Mode, r: Range, grain: Grain) {
  const trunc = sql.raw(`'${grain}'`); // whitelisted by the route's enum
  const range = sql`${r.from ? sql` and e.entry_date >= ${r.from}::date` : sql``}${r.to ? sql` and e.entry_date <= ${r.to}::date` : sql``}`;
  const res = await db.execute<{ period: string; currency: string; gross: string; refunds: string; chargebacks: string; fees: string; recharged: string; profit: string }>(sql`
    select to_char(date_trunc(${trunc}, e.entry_date), 'YYYY-MM-DD') as period, e.currency,
      sum(case when a.system_key = 'ticket_sales' then l.credit - l.debit else 0 end)::text as gross,
      sum(case when a.system_key = 'refunds' then l.debit - l.credit else 0 end)::text as refunds,
      sum(case when a.system_key = 'chargebacks' then l.debit - l.credit else 0 end)::text as chargebacks,
      sum(case when a.system_key = 'stripe_fees' then l.debit - l.credit else 0 end)::text as fees,
      sum(case when a.system_key = 'stripe_fee_recharges' then l.credit - l.debit else 0 end)::text as recharged,
      sum(case when a.type in ('REVENUE', 'EXPENSE') then l.credit - l.debit else 0 end)::text as profit
    from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} ${range}
    group by 1, 2 order by 1, 2`);
  return res.rows
    .map((x) => {
      const gross = n(x.gross), refunds = n(x.refunds), chargebacks = n(x.chargebacks), stripeFees = n(x.fees);
      return { period: x.period, currency: x.currency, grossSales: gross, refunds, chargebacks, stripeFees, feesRecharged: n(x.recharged), net: gross - refunds - chargebacks - stripeFees, bilitProfit: n(x.profit) };
    })
    .filter((x) => x.grossSales || x.refunds || x.chargebacks || x.stripeFees || x.bilitProfit);
}

/** Stripe connection + last sync, and counts of things waiting for a person. Each count links to the screen that resolves it. */
export async function dashboardStatus(orgId: string, mode: Mode) {
  const live = isLive(mode);
  const bt = schema.stripeBalanceTransactions;
  const [acc, [lastRun], counts, balances, pendingPays, payouts] = await Promise.all([
    getStripeAccount(orgId, mode),
    db.select({ status: schema.acctSyncRuns.status, kind: schema.acctSyncRuns.kind, finishedAt: schema.acctSyncRuns.finishedAt, createdAt: schema.acctSyncRuns.createdAt, imported: schema.acctSyncRuns.imported, errors: schema.acctSyncRuns.errors, error: schema.acctSyncRuns.error })
      .from(schema.acctSyncRuns).where(and(eq(schema.acctSyncRuns.organisationId, orgId), eq(schema.acctSyncRuns.livemode, live))).orderBy(desc(schema.acctSyncRuns.createdAt)).limit(1),
    db.execute<{ total: number; unmatched: number; review: number; unlinked_refunds: number; open_errors: number }>(sql`
      select count(*)::int as total,
        count(*) filter (where ${bt.reconciliationStatus} = 'UNMATCHED')::int as unmatched,
        count(*) filter (where ${bt.reconciliationStatus} in ('PARTIAL', 'DUPLICATE', 'MANUAL_REVIEW', 'ERROR'))::int as review,
        count(*) filter (where ${bt.kind} = 'REFUND' and ${bt.eventId} is null)::int as unlinked_refunds,
        (select count(*)::int from acct_sync_errors se where se.organisation_id = ${orgId} and se.livemode = ${live} and se.resolved_at is null) as open_errors
      from ${bt} where ${bt.organisationId} = ${orgId} and ${bt.livemode} = ${live}`),
    organiserBalances(orgId, mode),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.acctOrganiserPayments).where(and(eq(schema.acctOrganiserPayments.organisationId, orgId), eq(schema.acctOrganiserPayments.livemode, live), eq(schema.acctOrganiserPayments.status, "PENDING"))),
    db.select({ status: schema.acctStripeOutbound.status, n: sql<number>`count(*)::int` }).from(schema.acctStripeOutbound)
      .where(and(eq(schema.acctStripeOutbound.organisationId, orgId), eq(schema.acctStripeOutbound.livemode, live), sql`${schema.acctStripeOutbound.updatedAt} > now() - interval '30 days'`)).groupBy(schema.acctStripeOutbound.status),
  ]);
  const c = counts.rows[0] ?? { total: 0, unmatched: 0, review: 0, unlinked_refunds: 0, open_errors: 0 };
  const owed = balances.filter((b) => b.remaining > 0);
  const view = stripeAccountView(acc, mode);
  const pc = Object.fromEntries(payouts.map((p) => [p.status, p.n])) as Record<string, number>;
  return {
    stripe: {
      connected: view.connected, status: view.status, displayName: "displayName" in view ? view.displayName : null,
      lastSyncAt: "lastSyncAt" in view ? view.lastSyncAt : null, lastWebhookAt: "lastWebhookAt" in view ? view.lastWebhookAt : null, lastError: "lastError" in view ? view.lastError : null,
      lastRun: lastRun ?? null, transactions: n(c.total), openSyncErrors: n(c.open_errors),
    },
    review: {
      unmatched: n(c.unmatched), needsReview: n(c.review), unlinkedRefunds: n(c.unlinked_refunds),
      organisersOwed: new Set(owed.map((b) => b.organiserId)).size, owedByCurrency: Object.entries(owed.reduce<Record<string, number>>((m, b) => ({ ...m, [b.currency]: (m[b.currency] ?? 0) + b.remaining }), {})).map(([currency, amount]) => ({ currency, amount })),
      pendingOrganiserPayments: n(pendingPays[0]?.n), payoutsFailed: (pc.FAILED ?? 0) + (pc.RETURNED ?? 0), payoutsUnconfirmed: pc.SENDING ?? 0,
    },
  };
}
