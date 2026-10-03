import type Stripe from "stripe";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError } from "../errors";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { accountingEnabled, acctAudit, isLive, lockKey, modeOf, type Mode } from "./core";
import { postEntry, reverseEntry } from "./ledger";
import { importBalanceTransaction, importContext, upsertCharge, upsertDispute, upsertPayout, upsertRefund, type ImportContext } from "./importer";
import { rematchUnmatched } from "./manual";
import { gatewayFor, getStripeAccount, safeStripeError, type StripeAccountRow } from "./stripe-gateway";
import type { RequestContext } from "../audit";

export const SYNC_KINDS = ["RECENT", "RANGE", "FULL", "RETRY", "RECONCILE"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number] | "SCHEDULED";
type Run = typeof schema.acctSyncRuns.$inferSelect;

/** Queue a sync run. One import run per Stripe account at a time; reconciliation may run alongside. */
export async function createSyncRun(a: { orgId: string; mode: Mode; kind: SyncKind; from?: Date | null; to?: Date | null; userId?: string | null; ctx?: RequestContext }) {
  const acc = await getStripeAccount(a.orgId, a.mode);
  if (!acc || acc.status === "DISCONNECTED" || !acc.secretKeyEnc) throw new AppError("invalid_state", `Connect Stripe ${a.mode} mode before syncing.`);
  if (a.from && a.to && a.from > a.to) throw new AppError("validation_failed", "The start date must be before the end date.");
  const now = new Date();
  const range = a.kind === "FULL" ? { from: null, to: null } : a.kind === "RECENT" ? { from: new Date(now.getTime() - 7 * 86400_000), to: null } : a.kind === "SCHEDULED" ? { from: new Date((acc.lastSyncAt ?? now).getTime() - 3 * 86400_000), to: null } : { from: a.from ?? null, to: a.to ?? null };
  return db.transaction(async (tx) => {
    await lockKey(tx, `sync:${acc.id}`);
    if (a.kind !== "RECONCILE") {
      const [busy] = await tx.select({ id: schema.acctSyncRuns.id }).from(schema.acctSyncRuns).where(and(eq(schema.acctSyncRuns.stripeAccountRef, acc.id), inArray(schema.acctSyncRuns.status, ["QUEUED", "RUNNING"]), sql`${schema.acctSyncRuns.kind} <> 'RECONCILE'`)).limit(1);
      if (busy) throw new AppError("conflict", "A synchronisation is already running for this Stripe account.", { runId: busy.id });
    }
    const [run] = await tx.insert(schema.acctSyncRuns).values({ organisationId: a.orgId, stripeAccountRef: acc.id, livemode: acc.livemode, kind: a.kind, rangeFrom: range.from, rangeTo: range.to, requestedBy: a.userId ?? null }).returning();
    await enqueue(tx, QUEUES.acctSync, { runId: run!.id }, { singletonKey: run!.id });
    if (a.userId) await acctAudit(tx, { orgId: a.orgId, userId: a.userId, ctx: a.ctx, action: "sync.requested", entity: "sync_run", entityId: run!.id, new: { kind: a.kind, mode: a.mode, from: range.from, to: range.to } });
    return run!;
  });
}

const sec = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : undefined);

async function recordError(run: Pick<Run, "id" | "organisationId" | "stripeAccountRef" | "livemode"> | null, acc: StripeAccountRow, objectId: string | null, stage: string, e: unknown) {
  const message = safeStripeError(e);
  log.warn("accounting.sync_error", { runId: run?.id, objectId, stage, error: message });
  await db.insert(schema.acctSyncErrors).values({ organisationId: acc.organisationId, runId: run?.id ?? null, stripeAccountRef: acc.id, livemode: acc.livemode, objectId, stage, message });
}

/** Worker entry point. Resumable: progress (cursor + counters) is saved after every page, so a crash continues where it stopped. */
export async function executeRun(runId: string) {
  const [run] = await db.select().from(schema.acctSyncRuns).where(eq(schema.acctSyncRuns.id, runId));
  if (!run || ["SUCCEEDED", "PARTIAL", "FAILED"].includes(run.status)) return;
  const [acc] = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, run.stripeAccountRef));
  await db.update(schema.acctSyncRuns).set({ status: "RUNNING", startedAt: run.startedAt ?? new Date() }).where(eq(schema.acctSyncRuns.id, run.id));
  const c = { discovered: run.discovered, imported: run.imported, existing: run.existing, newlyMatched: run.newlyMatched, unmatched: run.unmatched, errors: run.errors };
  try {
    const ctx = await importContext(acc!, gatewayFor(acc!));
    let summary: Record<string, unknown> = {};
    if (run.kind === "RECONCILE") summary = { rematch: await rematchUnmatched(acc!.organisationId), ...(await reconcile(ctx)) };
    else if (run.kind === "RETRY") await retryErrors(ctx, run, c);
    else {
      let cursor = run.cursor ?? undefined;
      for (;;) {
        const page = await ctx.gw.listBalanceTransactions({ createdGte: sec(run.rangeFrom), createdLte: sec(run.rangeTo), startingAfter: cursor });
        for (const bt of page.data) {
          c.discovered++;
          try {
            const r = await importBalanceTransaction(ctx, bt);
            if (r.created) c.imported++; else c.existing++;
            if (r.newlyMatched) c.newlyMatched++;
            if (r.row.matchStatus === "UNMATCHED" || r.row.reconciliationStatus === "MANUAL_REVIEW") c.unmatched++;
          } catch (e) { c.errors++; await recordError(run, acc!, bt.id, "import", e); }
        }
        cursor = page.data.at(-1)?.id ?? cursor;
        await db.update(schema.acctSyncRuns).set({ ...c, cursor: cursor ?? null }).where(eq(schema.acctSyncRuns.id, run.id));
        if (!page.hasMore || !page.data.length) break;
      }
      summary.payouts = await syncPayouts(ctx, run, c);
      // Every sync ends by re-linking anything that can now be matched (sales to new events, refunds to their sale).
      summary.rematch = await rematchUnmatched(acc!.organisationId);
      summary.reconciliation = await reconcile(ctx);
    }
    const status = c.errors > 0 ? "PARTIAL" : "SUCCEEDED";
    await db.update(schema.acctSyncRuns).set({ ...c, status, summary, finishedAt: new Date() }).where(eq(schema.acctSyncRuns.id, run.id));
    await db.update(schema.stripeAccounts).set({ lastSyncAt: new Date(), ...(run.kind !== "RECONCILE" ? { status: "CONNECTED", lastError: null } : {}) }).where(eq(schema.stripeAccounts.id, acc!.id));
  } catch (e) {
    const msg = safeStripeError(e);
    log.error("accounting.sync_failed", { runId, error: msg });
    await db.update(schema.acctSyncRuns).set({ ...c, status: "FAILED", error: msg, finishedAt: new Date() }).where(eq(schema.acctSyncRuns.id, run.id));
    await recordError(run, acc!, null, "fetch", e);
  }
}

async function retryErrors(ctx: ImportContext, run: Run, c: Record<string, number>) {
  const errs = await db.select().from(schema.acctSyncErrors).where(and(eq(schema.acctSyncErrors.stripeAccountRef, ctx.acc.id), isNull(schema.acctSyncErrors.resolvedAt))).orderBy(schema.acctSyncErrors.createdAt).limit(5000);
  const seen = new Set<string>();
  for (const e of errs) {
    if (!e.objectId) { await db.update(schema.acctSyncErrors).set({ resolvedAt: new Date() }).where(eq(schema.acctSyncErrors.id, e.id)); continue; }
    if (seen.has(e.objectId)) { await db.update(schema.acctSyncErrors).set({ resolvedAt: new Date() }).where(eq(schema.acctSyncErrors.id, e.id)); continue; }
    seen.add(e.objectId);
    c.discovered!++;
    try {
      if (e.objectId.startsWith("txn_")) {
        const r = await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(e.objectId));
        if (r.created) c.imported!++; else c.existing!++;
        if (r.newlyMatched) c.newlyMatched!++;
      } else if (e.objectId.startsWith("po_")) await processPayout(ctx, await ctx.gw.retrievePayout(e.objectId));
      else if (e.objectId.startsWith("evt_")) {
        const [ev] = await db.select().from(schema.stripeEvents).where(and(eq(schema.stripeEvents.stripeAccountRef, ctx.acc.id), eq(schema.stripeEvents.eventId, e.objectId)));
        if (ev) await processEventRow(ctx, ev);
      }
      await db.update(schema.acctSyncErrors).set({ resolvedAt: new Date() }).where(and(eq(schema.acctSyncErrors.stripeAccountRef, ctx.acc.id), eq(schema.acctSyncErrors.objectId, e.objectId), isNull(schema.acctSyncErrors.resolvedAt)));
    } catch (x) { c.errors!++; await recordError(run, ctx.acc, e.objectId, "retry", x); }
  }
}

// ---------- payouts ----------
async function syncPayouts(ctx: ImportContext, run: Run, c: Record<string, number>) {
  let cursor: string | undefined, n = 0;
  for (;;) {
    const page = await ctx.gw.listPayouts({ createdGte: sec(run.rangeFrom), createdLte: sec(run.rangeTo), startingAfter: cursor });
    for (const p of page.data) {
      n++;
      try { await processPayout(ctx, p); } catch (e) { c.errors!++; await recordError(run, ctx.acc, p.id, "payout", e); }
    }
    cursor = page.data.at(-1)?.id;
    if (!page.hasMore || !cursor) break;
  }
  return { processed: n };
}

/**
 * A payout moves money from the Stripe balance to Bilit's bank; it is never a sale. Its balance transaction books
 * Stripe Balance → In Transit; once Stripe reports it paid, In Transit → Bank. A payout that later fails is reversed.
 */
export async function processPayout(ctx: ImportContext, p: Stripe.Payout) {
  await upsertPayout(db, ctx.acc, p);
  const btId = typeof p.balance_transaction === "string" ? p.balance_transaction : p.balance_transaction?.id;
  if (btId) {
    const [have] = await db.select({ id: schema.stripeBalanceTransactions.id }).from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), eq(schema.stripeBalanceTransactions.balanceTransactionId, btId)));
    if (!have) await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(btId));
  }
  const failBt = typeof p.failure_balance_transaction === "string" ? p.failure_balance_transaction : p.failure_balance_transaction?.id;
  if (failBt) await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(failBt));

  const paidKey = `payout:${ctx.acc.id}:${p.id}:paid`;
  await db.transaction(async (tx) => {
    await lockKey(tx, paidKey);
    const [paid] = await tx.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.organisationId, ctx.acc.organisationId), eq(schema.acctJournalEntries.idempotencyKey, paidKey)));
    if (p.status === "paid" && !paid) {
      await postEntry(tx, {
        orgId: ctx.acc.organisationId, livemode: ctx.acc.livemode, entryType: "PAYOUT_PAID", sourceDate: new Date((p.arrival_date || p.created) * 1000), currency: p.currency,
        description: `Stripe payout ${p.id} arrived in bank${p.statement_descriptor ? ` (${p.statement_descriptor})` : ""}`, reference: p.id, stripeAccountRef: ctx.acc.id,
        sourceType: "stripe_payout", sourceId: p.id, idempotencyKey: paidKey, timezone: ctx.settings.timezone,
        postings: [{ account: "bank", amount: p.amount, memo: "Payout received" }, { account: "payouts_in_transit", amount: -p.amount, memo: "Payout received" }],
      }, ctx.accounts);
    } else if ((p.status === "failed" || p.status === "canceled") && paid && paid.status === "POSTED") {
      await reverseEntry(tx, { orgId: ctx.acc.organisationId, entryId: paid.id, reason: `Payout ${p.status}`, timezone: ctx.settings.timezone });
    }
  });
  await reconcilePayout(ctx, p);
}

/** Link the balance transactions a payout settled and check they add up to the payout amount. */
async function reconcilePayout(ctx: ImportContext, p: Stripe.Payout) {
  const where = and(eq(schema.stripePayouts.stripeAccountRef, ctx.acc.id), eq(schema.stripePayouts.payoutId, p.id));
  if (p.status === "failed" || p.status === "canceled") { await db.update(schema.stripePayouts).set({ reconciliationStatus: "MATCHED", reconciledAt: new Date() }).where(where); return; }
  if (!p.automatic) {
    // Manual payouts are not tied to specific transactions in Stripe; the payout transaction itself is the reconciling item.
    await db.update(schema.stripePayouts).set({ reconciliationStatus: btIdOf(p) ? "MATCHED" : "PARTIAL", reconciledAt: new Date() }).where(where);
    return;
  }
  if (p.status !== "paid") return;
  const ids: string[] = []; let net = 0; let cursor: string | undefined;
  for (;;) {
    const page = await ctx.gw.listBalanceTransactions({ payout: p.id, startingAfter: cursor });
    for (const bt of page.data) {
      if (bt.type === "payout" && (typeof bt.source === "string" ? bt.source : bt.source?.id) === p.id) continue;
      ids.push(bt.id); net += bt.net;
      const [have] = await db.select({ id: schema.stripeBalanceTransactions.id }).from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), eq(schema.stripeBalanceTransactions.balanceTransactionId, bt.id)));
      if (!have) await importBalanceTransaction(ctx, bt);
    }
    cursor = page.data.at(-1)?.id;
    if (!page.hasMore || !cursor) break;
  }
  for (let i = 0; i < ids.length; i += 500) await db.update(schema.stripeBalanceTransactions).set({ payoutId: p.id }).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), inArray(schema.stripeBalanceTransactions.balanceTransactionId, ids.slice(i, i + 500))));
  await db.update(schema.stripePayouts).set({ includedCount: ids.length, includedNet: net, reconciliationStatus: net === p.amount ? "MATCHED" : "PARTIAL", reconciledAt: new Date() }).where(where);
}
const btIdOf = (p: Stripe.Payout) => (typeof p.balance_transaction === "string" ? p.balance_transaction : p.balance_transaction?.id);

// ---------- reconciliation ----------
/**
 * Compare the ledger with Stripe: every transaction posted exactly once with the right net, ledger Stripe Balance per
 * currency equal to the sum of imported transactions, and (informational) the live Stripe balance.
 */
export async function reconcile(ctx: ImportContext) {
  const acc = ctx.acc;
  const unposted = await db.execute<{ id: string }>(sql`select id from stripe_balance_transactions where stripe_account_ref = ${acc.id} and posted_entry_id is null limit 500`);
  // Net booked to Stripe Balance per transaction (original + reversals + reposts) must equal Stripe's net.
  const mismatched = await db.execute<{ id: string; net: string; booked: string }>(sql`
    select bt.id, bt.net::text, coalesce(sum(l.debit - l.credit), 0)::text as booked
    from stripe_balance_transactions bt
    left join acct_journal_entries e on e.organisation_id = bt.organisation_id and e.stripe_balance_transaction_id = bt.balance_transaction_id and e.stripe_account_ref = bt.stripe_account_ref
    left join acct_journal_lines l on l.entry_id = e.id and l.account_id = ${ctx.accounts.stripe_balance}
    where bt.stripe_account_ref = ${acc.id}
    group by bt.id, bt.net having coalesce(sum(l.debit - l.credit), 0) <> bt.net limit 500`);
  const bad = [...unposted.rows.map((r) => r.id), ...mismatched.rows.map((r) => r.id)];
  if (bad.length) await db.update(schema.stripeBalanceTransactions).set({ reconciliationStatus: "ERROR", reconciliationNote: "Ledger does not match the Stripe net amount" }).where(inArray(schema.stripeBalanceTransactions.id, bad));
  const ledger = await db.execute<{ currency: string; booked: string; stripe_net: string }>(sql`
    select x.currency, coalesce(l.booked, 0)::text as booked, x.net::text as stripe_net from
      (select currency, sum(net) as net from stripe_balance_transactions where stripe_account_ref = ${acc.id} group by currency) x
      left join (select e.currency, sum(l.debit - l.credit) as booked from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id
                 where e.stripe_account_ref = ${acc.id} and l.account_id = ${ctx.accounts.stripe_balance} group by e.currency) l on l.currency = x.currency`);
  const statuses = await db.execute<{ status: string; n: number }>(sql`select reconciliation_status as status, count(*)::int as n from stripe_balance_transactions where stripe_account_ref = ${acc.id} group by 1`);
  const chargesWithoutBt = await db.execute<{ n: number }>(sql`select count(*)::int as n from stripe_charges c where c.stripe_account_ref = ${acc.id} and c.status = 'succeeded' and c.paid and not exists (select 1 from stripe_balance_transactions b where b.stripe_account_ref = c.stripe_account_ref and b.charge_id = c.charge_id and b.kind = 'SALE')`);
  let stripeBalance: Array<{ currency: string; available: number; pending: number }> | null = null, balanceError: string | null = null;
  try {
    const b = await ctx.gw.retrieveBalance();
    const m = new Map<string, { currency: string; available: number; pending: number }>();
    for (const x of b.available) m.set(x.currency, { currency: x.currency, available: x.amount, pending: 0 });
    for (const x of b.pending) m.set(x.currency, { ...(m.get(x.currency) ?? { currency: x.currency, available: 0, pending: 0 }), pending: x.amount });
    stripeBalance = [...m.values()];
  } catch (e) { balanceError = safeStripeError(e); }
  const summary = {
    at: new Date().toISOString(), mode: modeOf(acc.livemode),
    ledgerErrors: bad.length, chargesWithoutBalanceTransaction: chargesWithoutBt.rows[0]?.n ?? 0,
    byStatus: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
    currencies: ledger.rows.map((r) => {
      const live = stripeBalance?.find((s) => s.currency === r.currency);
      return { currency: r.currency, ledgerStripeBalance: Number(r.booked), importedNet: Number(r.stripe_net), ledgerDifference: Number(r.booked) - Number(r.stripe_net), stripeReportedBalance: live ? live.available + live.pending : null, stripeDifference: live ? Number(r.booked) - (live.available + live.pending) : null };
    }),
    stripeBalance, balanceError,
  };
  return summary;
}

// ---------- webhooks ----------
type EventRow = typeof schema.stripeEvents.$inferSelect;

/** Webhook payloads are only hints: the referenced object is always re-fetched from the Stripe API before it is used. */
export async function processEventRow(ctx: ImportContext, ev: EventRow) {
  const id = ev.objectId ?? "";
  const importCharge = async (chargeId: string) => {
    const c = await ctx.gw.retrieveCharge(chargeId);
    ctx.charges.set(c.id, c);
    await upsertCharge(db, ctx.acc, c);
    const bt = typeof c.balance_transaction === "string" ? c.balance_transaction : c.balance_transaction?.id;
    if (bt) await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(bt));
    if (c.refunded || c.amount_refunded > 0) for (const r of await ctx.gw.listRefundsForCharge(c.id)) await importRefund(r);
  };
  const importRefund = async (r: Stripe.Refund) => {
    await upsertRefund(db, ctx.acc, r);
    const bt = typeof r.balance_transaction === "string" ? r.balance_transaction : r.balance_transaction?.id;
    if (bt) await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(bt));
    const fbt = typeof r.failure_balance_transaction === "string" ? r.failure_balance_transaction : r.failure_balance_transaction?.id;
    if (fbt) await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(fbt));
  };
  let handled = true;
  if (ev.type.startsWith("payment_intent.")) {
    const pi = await ctx.gw.retrievePaymentIntent(id);
    const latest = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
    if (latest) await importCharge(latest);
  } else if (id.startsWith("ch_") || id.startsWith("py_")) await importCharge(id);
  else if (id.startsWith("re_") || id.startsWith("pyr_")) await importRefund(await ctx.gw.retrieveRefund(id));
  else if (id.startsWith("du_") || id.startsWith("dp_")) {
    const d = await ctx.gw.retrieveDispute(id);
    await upsertDispute(db, ctx.acc, d);
    for (const bt of d.balance_transactions ?? []) await importBalanceTransaction(ctx, bt);
  } else if (id.startsWith("po_")) await processPayout(ctx, await ctx.gw.retrievePayout(id));
  else handled = false;
  await db.update(schema.stripeEvents).set({ status: handled ? "PROCESSED" : "IGNORED", processedAt: new Date(), error: null }).where(eq(schema.stripeEvents.id, ev.id));
}

export async function processStripeEvent(eventRowId: string) {
  const [ev] = await db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.id, eventRowId));
  if (!ev || ev.status === "PROCESSED" || ev.status === "IGNORED") return;
  const [acc] = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, ev.stripeAccountRef));
  await db.update(schema.stripeEvents).set({ attempts: sql`${schema.stripeEvents.attempts} + 1` }).where(eq(schema.stripeEvents.id, ev.id));
  try {
    await processEventRow(await importContext(acc!, gatewayFor(acc!)), ev);
  } catch (e) {
    const msg = safeStripeError(e);
    await db.update(schema.stripeEvents).set({ status: "FAILED", error: msg }).where(eq(schema.stripeEvents.id, ev.id));
    await recordError(null, acc!, ev.eventId, "webhook", e);
    throw e;
  }
}

/** Scheduled incremental sync (every 30 min): webhooks are the fast path, this closes any gap they leave. */
export async function scanScheduledSyncs() {
  if (!accountingEnabled()) return 0;
  const accs = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.status, "CONNECTED"));
  let n = 0;
  for (const a of accs) {
    try { await createSyncRun({ orgId: a.organisationId, mode: modeOf(a.livemode), kind: "SCHEDULED" }); n++; }
    catch (e) { if (!(e instanceof AppError && e.code === "conflict")) log.warn("accounting.scheduled_sync_failed", { account: a.id, error: safeStripeError(e) }); }
  }
  return n;
}

export async function latestRuns(orgId: string, mode: Mode, limit = 20) {
  return db.select().from(schema.acctSyncRuns).where(and(eq(schema.acctSyncRuns.organisationId, orgId), eq(schema.acctSyncRuns.livemode, isLive(mode)))).orderBy(desc(schema.acctSyncRuns.createdAt)).limit(limit);
}
