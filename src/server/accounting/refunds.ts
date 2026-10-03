import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { acctAudit, isLive, type Mode } from "./core";
import { importBalanceTransaction, importContext, upsertCharge, upsertRefund } from "./importer";
import { gatewayFor, safeStripeError } from "./stripe-gateway";

type Actor = { orgId: string; userId: string; ctx: RequestContext };

/**
 * Refunds issued from the finance dashboard. The refundable amount is always checked against Stripe at that moment, the
 * request carries a client-generated id as Stripe idempotency key (a double click can never refund twice), and the
 * resulting refund is imported straight away so the ledger, event figures and organiser balance update immediately.
 */
export const RefundInput = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.enum(["requested_by_customer", "duplicate", "fraudulent"]).default("requested_by_customer"),
  note: z.string().trim().max(500).optional().nullable(),
  keepBookingFee: z.boolean().default(false), // refund the ticket price only; Bilit keeps its booking fee
  requestId: z.string().uuid(),
});

function stripeFailure(e: unknown): never {
  const type = (e as { type?: string }).type;
  if (type === "StripePermissionError") throw new AppError("forbidden", "The connected Stripe key cannot create refunds. In Stripe, give the restricted key the permission “Refunds: Write”, then reconnect it under Finance → Stripe.");
  throw new AppError("invalid_state", `Stripe refused the refund: ${safeStripeError(e)}`);
}

export async function issueRefund(a: Actor, btId: string, input: z.infer<typeof RefundInput>) {
  const bt = schema.stripeBalanceTransactions;
  const [row] = await db.select().from(bt).where(and(eq(bt.id, btId), eq(bt.organisationId, a.orgId)));
  if (!row) throw new AppError("not_found", "Transaction not found");
  if (row.kind !== "SALE" || !row.chargeId) throw new AppError("invalid_state", "Only ticket sales can be refunded.");
  const [acc] = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, row.stripeAccountRef));
  const gw = gatewayFor(acc!);
  const charge = await gw.retrieveCharge(row.chargeId).catch(stripeFailure);
  if (charge.disputed) throw new AppError("invalid_state", "This payment is disputed (chargeback). Respond to the dispute in Stripe instead of refunding.");
  if (charge.status !== "succeeded") throw new AppError("invalid_state", `The payment is ${charge.status}; nothing to refund.`);
  const refundable = (charge.amount_captured ?? charge.amount) - (charge.amount_refunded ?? 0);
  if (refundable <= 0) throw new AppError("invalid_state", "This payment has already been fully refunded.");
  if (input.amount > refundable) throw new AppError("validation_failed", `At most ${refundable} (minor units) can still be refunded.`, [{ path: "amount", message: "More than the refundable amount" }]);
  const refund = await gw.createRefund({ charge: row.chargeId, amount: input.amount, reason: input.reason, metadata: { bilit_refund_request: input.requestId, bilit_user: a.userId, ...(input.keepBookingFee ? { bilit_keep_booking_fee: "1" } : {}), ...(row.eventCode ? { event_code: row.eventCode } : {}) } }, `bilit-refund:${input.requestId}`).catch(stripeFailure);
  // Import now (the webhook/sync would also pick it up; imports are idempotent).
  const ctx = await importContext(acc!, gw);
  await upsertCharge(db, acc!, await gw.retrieveCharge(row.chargeId));
  await upsertRefund(db, acc!, refund);
  await db.update(schema.stripeRefunds).set({ requestedBy: a.userId, note: input.note ?? null }).where(and(eq(schema.stripeRefunds.stripeAccountRef, acc!.id), eq(schema.stripeRefunds.refundId, refund.id)));
  const rbt = typeof refund.balance_transaction === "string" ? refund.balance_transaction : refund.balance_transaction?.id;
  if (rbt) await importBalanceTransaction(ctx, await gw.retrieveBalanceTransaction(rbt));
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "refund.issued", entity: "stripe_balance_transaction", entityId: row.id, new: { refundId: refund.id, amount: input.amount, currency: row.currency, status: refund.status, reason: input.reason, keepBookingFee: input.keepBookingFee }, reason: input.note ?? null, extra: { eventId: row.eventId, chargeId: row.chargeId } }));
  return { refundId: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency, remaining: refundable - input.amount };
}

/** Re-fetch one payment (charge + its refunds + balance transactions) from Stripe, e.g. to see a refund's latest status. */
export async function refreshFromStripe(orgId: string, btId: string) {
  const bt = schema.stripeBalanceTransactions;
  const [row] = await db.select().from(bt).where(and(eq(bt.id, btId), eq(bt.organisationId, orgId)));
  if (!row?.chargeId) throw new AppError("invalid_state", "This transaction has no Stripe payment to refresh.");
  const [acc] = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, row.stripeAccountRef));
  const gw = gatewayFor(acc!);
  const ctx = await importContext(acc!, gw);
  try {
    const c = await gw.retrieveCharge(row.chargeId);
    await upsertCharge(db, acc!, c);
    for (const r of await gw.listRefundsForCharge(c.id)) {
      await upsertRefund(db, acc!, r);
      for (const id of [r.balance_transaction, r.failure_balance_transaction].map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean) as string[]) await importBalanceTransaction(ctx, await gw.retrieveBalanceTransaction(id));
    }
  } catch (e) { throw new AppError("invalid_state", `Stripe: ${safeStripeError(e)}`); }
  return { ok: true };
}

// ---------- all Stripe payments (including failed ones, which have no balance transaction) ----------
export const ChargeFilter = z.object({ status: z.enum(["succeeded", "failed", "pending", "refunded", "partially_refunded", "disputed", "issues"]).optional(), q: z.string().trim().max(120).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export async function listCharges(orgId: string, mode: Mode, f: z.infer<typeof ChargeFilter>, page: { limit: number; offset: number }) {
  const c = schema.stripeCharges;
  const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const st = f.status;
  const where = and(eq(c.organisationId, orgId), eq(c.livemode, isLive(mode)),
    st === "failed" ? eq(c.status, "failed") : st === "pending" ? eq(c.status, "pending") : st === "succeeded" ? eq(c.status, "succeeded")
      : st === "refunded" ? eq(c.refunded, true) : st === "partially_refunded" ? sql`${c.amountRefunded} > 0 and not ${c.refunded}` : st === "disputed" ? eq(c.disputed, true)
      : st === "issues" ? sql`(${c.status} <> 'succeeded' or ${c.disputed} or ${c.outcome}->>'riskLevel' in ('elevated','highest') or exists (select 1 from stripe_refunds r where r.stripe_account_ref = ${c.stripeAccountRef} and r.charge_id = ${c.chargeId} and r.status in ('failed','canceled','requires_action')))` : undefined,
    f.from ? sql`${c.stripeCreatedAt} >= ${f.from}::date` : undefined, f.to ? sql`${c.stripeCreatedAt} < (${f.to}::date + 1)` : undefined,
    f.q ? or(eq(c.chargeId, f.q), eq(c.paymentIntentId, f.q), ilike(c.customerEmail, like(f.q)), ilike(c.customerName, like(f.q)), ilike(c.description, like(f.q))) : undefined);
  const [items, total, counts] = await Promise.all([
    db.select({ c, btId: schema.stripeBalanceTransactions.id, eventName: schema.acctEvents.name, refundIssues: sql<number>`(select count(*)::int from stripe_refunds r where r.stripe_account_ref = ${c.stripeAccountRef} and r.charge_id = ${c.chargeId} and r.status in ('failed','canceled','requires_action'))` })
      .from(c).leftJoin(schema.stripeBalanceTransactions, and(eq(schema.stripeBalanceTransactions.stripeAccountRef, c.stripeAccountRef), eq(schema.stripeBalanceTransactions.chargeId, c.chargeId), eq(schema.stripeBalanceTransactions.kind, "SALE")))
      .leftJoin(schema.acctEvents, eq(schema.acctEvents.id, schema.stripeBalanceTransactions.eventId)).where(where).orderBy(desc(c.stripeCreatedAt)).limit(page.limit).offset(page.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(c).where(where),
    db.execute<{ failed: number; disputed: number; refunded: number; risky: number }>(sql`select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where disputed)::int as disputed, count(*) filter (where amount_refunded > 0)::int as refunded, count(*) filter (where outcome->>'riskLevel' in ('elevated','highest'))::int as risky from stripe_charges where organisation_id = ${orgId} and livemode = ${isLive(mode)}`),
  ]);
  return { items: items.map((r) => ({ ...r.c, btId: r.btId, eventName: r.eventName, refundIssues: r.refundIssues })), total: total[0]?.n ?? 0, counts: counts.rows[0] };
}

// ---------- refunds overview ----------
export const RefundFilter = z.object({ linked: z.enum(["yes", "no"]).optional(), eventId: z.string().uuid().optional(), q: z.string().trim().max(120).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/**
 * Every refund/chargeback with its original sale: who, which event, how much of it was ticket price and how much booking
 * fee, the Stripe refund status and whether it is linked to an event. Unlinked ones are grouped by detected event code.
 */
export async function refundsOverview(orgId: string, mode: Mode, f: z.infer<typeof RefundFilter>, page: { limit: number; offset: number }) {
  const live = isLive(mode);
  const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const where = sql`r.organisation_id = ${orgId} and r.livemode = ${live} and r.kind in ('REFUND', 'DISPUTE')
    ${f.linked === "yes" ? sql` and r.match_status = 'MATCHED'` : f.linked === "no" ? sql` and r.match_status <> 'MATCHED'` : sql``}
    ${f.eventId ? sql` and r.event_id = ${f.eventId}` : sql``}
    ${f.from ? sql` and r.stripe_created_at >= ${f.from}::date` : sql``} ${f.to ? sql` and r.stripe_created_at < (${f.to}::date + 1)` : sql``}
    ${f.q ? sql` and (ch.customer_name ilike ${like(f.q)} or ch.customer_email ilike ${like(f.q)} or ch.description ilike ${like(f.q)} or r.event_code ilike ${like(f.q)} or r.charge_id = ${f.q})` : sql``}`;
  const from = sql`stripe_balance_transactions r
    left join stripe_balance_transactions s on s.stripe_account_ref = r.stripe_account_ref and s.charge_id = r.charge_id and s.kind = 'SALE'
    left join stripe_charges ch on ch.stripe_account_ref = r.stripe_account_ref and ch.charge_id = r.charge_id
    left join stripe_refunds rf on rf.stripe_account_ref = r.stripe_account_ref and rf.refund_id = r.source_id
    left join acct_events ev on ev.id = r.event_id`;
  const [rows, total, sums, groups] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.kind, r.stripe_created_at, -r.amount as amount, r.currency, r.match_status, r.match_reason, r.event_id, upper(r.event_code) as event_code, ev.name as event_name,
        s.id as sale_id, s.amount as sale_amount, coalesce(s.commission_amount, 0) as sale_fee, s.match_status as sale_status, ch.customer_name, ch.customer_email, ch.description,
        rf.status as refund_status, rf.reason, rf.note, rf.keep_booking_fee, rf.failure_reason, coalesce(r.commission_amount, 0) as commission_reversed,
        (select coalesce(sum(-x.amount), 0) from stripe_balance_transactions x where x.stripe_account_ref = r.stripe_account_ref and x.charge_id = r.charge_id and x.kind in ('REFUND','DISPUTE') and x.stripe_created_at <= r.stripe_created_at) as refunded_so_far
      from ${from} where ${where} order by r.stripe_created_at desc limit ${page.limit} offset ${page.offset}`),
    db.execute<{ n: number }>(sql`select count(*)::int n from ${from} where ${where}`),
    db.execute<{ currency: string; n: number; amount: string; linked: number; unlinked_amount: string }>(sql`
      select r.currency, count(*)::int n, sum(-r.amount)::text amount, count(*) filter (where r.match_status = 'MATCHED')::int linked, coalesce(sum(-r.amount) filter (where r.match_status <> 'MATCHED'), 0)::text unlinked_amount
      from ${from} where r.organisation_id = ${orgId} and r.livemode = ${live} and r.kind in ('REFUND','DISPUTE') group by 1`),
    db.execute<{ code: string | null; currency: string; n: number; amount: string; sample: string | null; sales_unlinked: number; event_exists: boolean }>(sql`
      select upper(r.event_code) code, r.currency, count(*)::int n, sum(-r.amount)::text amount, max(ch.description) sample, count(*) filter (where s.match_status <> 'MATCHED')::int sales_unlinked,
        bool_or(exists (select 1 from acct_events e where e.organisation_id = ${orgId} and upper(e.code) = upper(r.event_code))) event_exists
      from ${from} where r.organisation_id = ${orgId} and r.livemode = ${live} and r.kind in ('REFUND','DISPUTE') and r.match_status <> 'MATCHED' group by 1, 2 order by 3 desc`),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    total: total.rows[0]?.n ?? 0,
    totals: sums.rows.map((x) => ({ currency: x.currency, count: x.n, amount: n(x.amount), linked: x.linked, unlinkedAmount: n(x.unlinked_amount) })),
    unlinkedGroups: groups.rows.map((g) => ({ code: g.code, currency: g.currency, count: g.n, amount: n(g.amount), eventName: g.sample?.match(/for event:\s*(.*)\s*\([A-Za-z0-9]+-[0-9]+\)/)?.[1]?.trim() ?? null, eventExists: g.event_exists })),
    items: rows.rows.map((x) => {
      const ticket = n(x.sale_amount) - n(x.sale_fee), so = n(x.refunded_so_far), before = so - n(x.amount);
      // Booking fee part of this refund: what it refunded beyond the ticket price (refunds are applied to the ticket first).
      const feePart = Math.max(0, so - Math.max(ticket, before)) ;
      return { id: x.id as string, kind: x.kind as string, date: x.stripe_created_at, amount: n(x.amount), currency: x.currency as string, linked: x.match_status === "MATCHED", matchReason: x.match_reason as string | null,
        eventId: x.event_id as string | null, eventCode: x.event_code as string | null, eventName: x.event_name as string | null, saleId: x.sale_id as string | null, saleAmount: n(x.sale_amount), saleFee: n(x.sale_fee), saleLinked: x.sale_status === "MATCHED",
        customerName: x.customer_name as string | null, customerEmail: x.customer_email as string | null, description: x.description as string | null,
        refundStatus: x.refund_status as string | null, reason: x.reason as string | null, note: x.note as string | null, failureReason: x.failure_reason as string | null,
        feeRefunded: x.sale_id && x.match_status === "MATCHED" ? feePart : null, feeKeptByBilit: n(x.commission_reversed) === 0 };
    }),
  };
}
