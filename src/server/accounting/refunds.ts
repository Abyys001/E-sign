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
