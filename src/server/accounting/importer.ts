import type Stripe from "stripe";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { AppError } from "../errors";
import { ensureLedgerSetup, getAcctSettings, lockKey, type AccountIds, type AcctSettings } from "./core";
import { postEntry, reverseEntry } from "./ledger";
import { extractEventCode, normCode, ticketQuantity, type CodeSource } from "./matcher";
import { btPostings, classifyBt, type Agreement, type BtKind } from "./postings";
import type { StripeAccountRow, StripeGateway } from "./stripe-gateway";

type EventInfo = { id: string; code: string; name: string; status: string; currency: string; organiserId: string | null; agreement: Agreement | null };
type BtRow = typeof schema.stripeBalanceTransactions.$inferSelect;

/** Per-run context: settings, chart of accounts, known events and small object caches (a sync touches one org + mode). */
export type ImportContext = {
  acc: StripeAccountRow; gw: StripeGateway; settings: AcctSettings; accounts: AccountIds;
  events: Map<string, EventInfo>; eventsById: Map<string, EventInfo>; charges: Map<string, Stripe.Charge>; intents: Map<string, Stripe.PaymentIntent | null>;
};

export async function loadEvents(orgId: string, tx: Tx | typeof db = db) {
  const rows = await tx.select({ e: schema.acctEvents, a: schema.acctAgreements }).from(schema.acctEvents).leftJoin(schema.acctAgreements, eq(schema.acctAgreements.id, schema.acctEvents.currentAgreementId)).where(eq(schema.acctEvents.organisationId, orgId));
  const byCode = new Map<string, EventInfo>(), byId = new Map<string, EventInfo>();
  for (const { e, a } of rows) {
    const info: EventInfo = { id: e.id, code: e.code, name: e.name, status: e.status, currency: e.currency, organiserId: e.organiserId, agreement: a ? agreementOf(a) : null };
    byCode.set(normCode(e.code), info); byId.set(e.id, info);
  }
  return { byCode, byId };
}
export const agreementOf = (a: typeof schema.acctAgreements.$inferSelect): Agreement => ({ id: a.id, percentBps: a.percentBps, percentBasis: a.percentBasis, fixedPerTicket: a.fixedPerTicket, fixedEventFee: a.fixedEventFee, stripeFeesBorneBy: a.stripeFeesBorneBy, chargebacksBorneBy: a.chargebacksBorneBy, refundsReverseCommission: a.refundsReverseCommission });

export async function importContext(acc: StripeAccountRow, gw: StripeGateway): Promise<ImportContext> {
  const settings = await getAcctSettings(acc.organisationId);
  const accounts = await ensureLedgerSetup(db, acc.organisationId);
  const ev = await loadEvents(acc.organisationId);
  return { acc, gw, settings, accounts, events: ev.byCode, eventsById: ev.byId, charges: new Map(), intents: new Map() };
}

const ts = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);
const obj = <T,>(x: unknown, kind: string): T | null => (x && typeof x === "object" && (x as { object?: string }).object === kind ? (x as T) : null);

// ---------- Stripe object mirrors (upserts: Stripe is the source of truth for these fields) ----------
/** Card / wallet summary of a charge (no full card data is ever available or stored). */
function paymentMethodOf(c: Stripe.Charge) {
  const d = c.payment_method_details;
  if (!d) return null;
  const card = d.card;
  return { type: d.type, brand: card?.brand ?? null, last4: card?.last4 ?? null, country: card?.country ?? null, funding: card?.funding ?? null, wallet: card?.wallet?.type ?? null, expMonth: card?.exp_month ?? null, expYear: card?.exp_year ?? null, threeDSecure: card?.three_d_secure?.result ?? null };
}

export async function upsertCharge(tx: Tx | typeof db, acc: StripeAccountRow, c: Stripe.Charge) {
  const v = {
    paymentIntentId: idOf(c.payment_intent), balanceTransactionId: idOf(c.balance_transaction), amount: c.amount, amountCaptured: c.amount_captured ?? 0, amountRefunded: c.amount_refunded ?? 0,
    currency: c.currency, status: c.status, paid: c.paid, refunded: c.refunded, disputed: c.disputed, description: c.description?.slice(0, 1000) ?? null,
    statementDescriptor: c.calculated_statement_descriptor ?? c.statement_descriptor ?? null, customerId: idOf(c.customer as string | { id: string } | null),
    customerName: c.billing_details?.name ?? null, customerEmail: c.billing_details?.email ?? c.receipt_email ?? null, metadata: c.metadata ?? {},
    failureCode: c.failure_code ?? null, failureMessage: c.failure_message?.slice(0, 500) ?? null,
    outcome: c.outcome ? { networkStatus: c.outcome.network_status ?? null, type: c.outcome.type ?? null, reason: c.outcome.reason ?? null, riskLevel: c.outcome.risk_level ?? null, riskScore: (c.outcome as { risk_score?: number }).risk_score ?? null, sellerMessage: c.outcome.seller_message ?? null } : null,
    paymentMethod: paymentMethodOf(c), receiptUrl: c.receipt_url ?? null,
    billingAddress: c.billing_details?.address ? { line1: c.billing_details.address.line1, line2: c.billing_details.address.line2, city: c.billing_details.address.city, postalCode: c.billing_details.address.postal_code, state: c.billing_details.address.state, country: c.billing_details.address.country } : null,
    updatedAt: new Date(),
  };
  await tx.insert(schema.stripeCharges).values({ organisationId: acc.organisationId, stripeAccountRef: acc.id, livemode: c.livemode, chargeId: c.id, stripeCreatedAt: new Date(c.created * 1000), ...v })
    .onConflictDoUpdate({ target: [schema.stripeCharges.stripeAccountRef, schema.stripeCharges.chargeId], set: v });
}

export async function upsertRefund(tx: Tx | typeof db, acc: StripeAccountRow, r: Stripe.Refund) {
  const v = { chargeId: idOf(r.charge), paymentIntentId: idOf(r.payment_intent), balanceTransactionId: idOf(r.balance_transaction), amount: r.amount, currency: r.currency, status: r.status ?? null, reason: r.reason ?? null, failureReason: r.failure_reason ?? null, keepBookingFee: r.metadata?.bilit_keep_booking_fee === "1", updatedAt: new Date() };
  await tx.insert(schema.stripeRefunds).values({ organisationId: acc.organisationId, stripeAccountRef: acc.id, livemode: acc.livemode, refundId: r.id, stripeCreatedAt: new Date(r.created * 1000), ...v })
    .onConflictDoUpdate({ target: [schema.stripeRefunds.stripeAccountRef, schema.stripeRefunds.refundId], set: v });
}

const disputeAcctStatus = (s: string) => (s === "won" ? "WON" : s === "lost" ? "LOST" : s === "warning_closed" ? "WON" : "OPEN");
export async function upsertDispute(tx: Tx | typeof db, acc: StripeAccountRow, d: Stripe.Dispute, link?: { eventId: string | null; organiserId: string | null }) {
  const closed = ["won", "lost", "warning_closed"].includes(d.status);
  const v = { chargeId: idOf(d.charge), amount: d.amount, currency: d.currency, reason: d.reason ?? null, status: d.status, accountingStatus: disputeAcctStatus(d.status), updatedAt: new Date(), ...(link ? { eventId: link.eventId, organiserId: link.organiserId } : {}) };
  const [row] = await tx.select({ closedAt: schema.stripeDisputes.closedAt }).from(schema.stripeDisputes).where(and(eq(schema.stripeDisputes.stripeAccountRef, acc.id), eq(schema.stripeDisputes.disputeId, d.id)));
  const closedAt = closed ? row?.closedAt ?? new Date() : null;
  await tx.insert(schema.stripeDisputes).values({ organisationId: acc.organisationId, stripeAccountRef: acc.id, livemode: d.livemode, disputeId: d.id, stripeCreatedAt: new Date(d.created * 1000), closedAt, ...v })
    .onConflictDoUpdate({ target: [schema.stripeDisputes.stripeAccountRef, schema.stripeDisputes.disputeId], set: { ...v, closedAt } });
}

export async function upsertPayout(tx: Tx | typeof db, acc: StripeAccountRow, p: Stripe.Payout) {
  const v = {
    amount: p.amount, currency: p.currency, status: p.status, automatic: p.automatic, method: p.method ?? null, description: p.description ?? null, statementDescriptor: p.statement_descriptor ?? null,
    balanceTransactionId: idOf(p.balance_transaction), failureBalanceTransactionId: idOf(p.failure_balance_transaction), failureCode: p.failure_code ?? null, failureMessage: p.failure_message ?? null,
    arrivalDate: ts(p.arrival_date), updatedAt: new Date(),
  };
  await tx.insert(schema.stripePayouts).values({ organisationId: acc.organisationId, stripeAccountRef: acc.id, livemode: p.livemode, payoutId: p.id, stripeCreatedAt: new Date(p.created * 1000), ...v })
    .onConflictDoUpdate({ target: [schema.stripePayouts.stripeAccountRef, schema.stripePayouts.payoutId], set: v });
}

// ---------- matching ----------
export type Allocation = { eventId: string | null; organiserId: string | null; agreement: Agreement | null; eventCode: string | null; matchStatus: "MATCHED" | "UNMATCHED" | "NOT_APPLICABLE"; matchReason: string | null; matchMethod: string | null; ticketQuantity: number | null; original: { amount: number; commission: number } | null };

/** Validate that an event can receive money; returns the reason it cannot, or null. */
export function eventProblem(e: EventInfo, currency: string): string | null {
  if (e.status !== "ACTIVE" && e.status !== "COMPLETED") return "EVENT_INACTIVE"; // a finished event still receives late sales / refunds
  if (!e.organiserId) return "NO_ORGANISER";
  if (!e.agreement) return "NO_AGREEMENT";
  if (e.currency !== currency) return "CURRENCY_MISMATCH";
  return null;
}

async function intentFor(ctx: ImportContext, c: Stripe.Charge) {
  const pi = idOf(c.payment_intent);
  if (!pi) return null;
  if (!ctx.intents.has(pi)) ctx.intents.set(pi, await ctx.gw.retrievePaymentIntent(pi).catch(() => null));
  return ctx.intents.get(pi) ?? null;
}

async function allocateSale(ctx: ImportContext, c: Stripe.Charge, currency: string): Promise<Allocation> {
  const needsPi = !c.description || ctx.settings.matchRules.some((r) => r.type === "METADATA" && !Object.keys(c.metadata ?? {}).some((k) => k.toLowerCase() === r.key.toLowerCase()));
  const pi = needsPi ? await intentFor(ctx, c) : null;
  return allocateFromSource(ctx, { description: c.description, metadata: c.metadata, paymentIntentDescription: pi?.description, paymentIntentMetadata: pi?.metadata }, currency);
}

/** Event allocation from Stripe description/metadata (also used to re-match already-imported sales without calling Stripe). */
export function allocateFromSource(ctx: Pick<ImportContext, "settings" | "events">, src: CodeSource, currency: string): Allocation {
  const ex = extractEventCode(src, ctx.settings.matchRules, new Set(ctx.events.keys()));
  const qty = ticketQuantity(src.metadata, src.paymentIntentMetadata, ctx.settings.ticketQuantityKey);
  const none = { eventId: null, organiserId: null, agreement: null, ticketQuantity: qty, original: null, matchStatus: "UNMATCHED" as const };
  if (!ex.ok) return { ...none, eventCode: ex.code ?? ex.candidates?.join(",") ?? null, matchReason: ex.reason, matchMethod: ex.method ?? null };
  const e = ctx.events.get(ex.code)!;
  const problem = eventProblem(e, currency);
  if (problem) return { ...none, eventId: e.id, eventCode: ex.code, matchReason: problem, matchMethod: ex.method };
  return { eventId: e.id, organiserId: e.organiserId, agreement: e.agreement, eventCode: ex.code, matchStatus: "MATCHED", matchReason: null, matchMethod: ex.method, ticketQuantity: qty, original: null };
}

/** Refunds and disputes follow their original sale: same event, organiser and agreement version. */
/** A refund issued with "Bilit keeps the booking fee": the organiser bears the whole refund, no commission is reversed. */
async function keepsBookingFee(tx: Tx, ctx: ImportContext, sourceId: string | null | undefined) {
  if (!sourceId) return false;
  const [r] = await tx.select({ k: schema.stripeRefunds.keepBookingFee }).from(schema.stripeRefunds).where(and(eq(schema.stripeRefunds.stripeAccountRef, ctx.acc.id), eq(schema.stripeRefunds.refundId, sourceId)));
  return !!r?.k;
}

export async function allocateDependent(tx: Tx, ctx: ImportContext, chargeId: string | null, sourceId?: string | null): Promise<Allocation> {
  const base = { eventId: null, organiserId: null, agreement: null, eventCode: null, matchStatus: "UNMATCHED" as const, matchMethod: null, ticketQuantity: null, original: null };
  if (!chargeId) return { ...base, matchReason: "ORIGINAL_MISSING" };
  const [orig] = await tx.select().from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), eq(schema.stripeBalanceTransactions.chargeId, chargeId), eq(schema.stripeBalanceTransactions.kind, "SALE")));
  if (!orig) return { ...base, matchReason: "ORIGINAL_MISSING" };
  if (orig.matchStatus !== "MATCHED" || !orig.agreementId) return { ...base, eventId: orig.eventId, eventCode: orig.eventCode, matchReason: "ORIGINAL_UNMATCHED" };
  const [a] = await tx.select().from(schema.acctAgreements).where(eq(schema.acctAgreements.id, orig.agreementId));
  // Platform policy (default): the booking fee is non-refundable — refunds never reduce it; the organiser bears the whole refund.
  const keep = !ctx.settings.bookingFeeRefundable || await keepsBookingFee(tx, ctx, sourceId);
  return { eventId: orig.eventId, organiserId: orig.organiserId, agreement: agreementOf(a!), eventCode: orig.eventCode, matchStatus: "MATCHED", matchReason: null, matchMethod: "INHERITED", ticketQuantity: null, original: { amount: orig.amount, commission: keep ? 0 : orig.commissionAmount ?? 0 } };
}

function reconStatus(kind: BtKind, al: Allocation, classified: boolean): string {
  if (kind === "SALE") return al.matchStatus === "MATCHED" ? "MATCHED" : al.matchReason === "AMBIGUOUS" ? "DUPLICATE" : "UNMATCHED";
  if (kind === "REFUND") return al.matchStatus === "MATCHED" ? "REFUND" : "PARTIAL";
  if (kind === "DISPUTE" || kind === "DISPUTE_REVERSAL") return al.matchStatus === "MATCHED" ? "DISPUTE" : "PARTIAL";
  if (kind === "OTHER") return classified ? "MATCHED" : "MANUAL_REVIEW";
  return "MATCHED";
}

// ---------- posting ----------
async function post(tx: Tx, ctx: ImportContext, row: BtRow, al: Allocation, opts: { userId?: string | null; reason?: string | null } = {}) {
  const kind = row.kind as BtKind;
  const matched = al.matchStatus === "MATCHED" && al.eventId && al.organiserId && al.agreement ? { eventId: al.eventId, organiserId: al.organiserId, agreement: al.agreement } : null;
  const r = btPostings({ kind, amount: row.amount, fee: row.fee, net: row.net, matched, ticketQuantity: al.ticketQuantity ?? undefined, original: al.original, classificationAccountId: row.classificationAccountId });
  const version = row.postingVersion + 1;
  const ev = matched ? ctx.eventsById.get(matched.eventId) : null;
  const { entry } = await postEntry(tx, {
    orgId: row.organisationId, livemode: row.livemode, entryType: r.entryType, sourceDate: row.stripeCreatedAt, currency: row.currency,
    description: `${kind === "SALE" ? "Ticket sale" : kind === "REFUND" ? "Refund" : kind === "DISPUTE" ? "Dispute" : kind === "DISPUTE_REVERSAL" ? "Dispute reversal" : kind === "PAYOUT" ? "Payout" : kind === "PAYOUT_REVERSAL" ? "Payout returned" : kind === "STRIPE_FEE" ? "Stripe fee" : `Stripe ${row.type}`}${ev ? ` — ${ev.name} (${ev.code})` : ""}${row.description ? ` — ${row.description}` : ""}`,
    reference: row.sourceId, eventId: matched?.eventId ?? null, organiserId: matched?.organiserId ?? null, stripeAccountRef: row.stripeAccountRef,
    stripeBalanceTransactionId: row.balanceTransactionId, sourceType: "stripe_balance_transaction", sourceId: row.id, agreementId: matched?.agreement.id ?? null,
    idempotencyKey: `bt:${row.stripeAccountRef}:${row.balanceTransactionId}:v${version}`, createdBy: opts.userId ?? null, reason: opts.reason ?? null, timezone: ctx.settings.timezone, postings: r.postings,
  }, ctx.accounts);
  const [upd] = await tx.update(schema.stripeBalanceTransactions).set({
    eventId: al.eventId, organiserId: al.organiserId, agreementId: matched?.agreement.id ?? null, eventCode: al.eventCode, matchStatus: al.matchStatus, matchReason: al.matchReason, matchMethod: al.matchMethod,
    ticketQuantity: al.ticketQuantity, reconciliationStatus: reconStatus(kind, al, !!row.classificationAccountId), commissionAmount: r.commission, organiserAmount: r.organiserAmount,
    postedEntryId: entry.id, postingVersion: version, updatedAt: new Date(),
  }).where(eq(schema.stripeBalanceTransactions.id, row.id)).returning();
  return upd!;
}

/** Replace the posting of a transaction: reverse what was posted, then post again with the new allocation. */
export async function repost(tx: Tx, ctx: ImportContext, row: BtRow, al: Allocation, opts: { userId?: string | null; reason?: string | null } = {}) {
  if (row.postedEntryId) await reverseEntry(tx, { orgId: row.organisationId, entryId: row.postedEntryId, reason: opts.reason ?? "Re-allocation", userId: opts.userId, timezone: ctx.settings.timezone });
  const updated = await post(tx, ctx, row, al, opts);
  if (row.kind === "SALE" && row.chargeId) await reallocateDependents(tx, ctx, row.chargeId, opts);
  return updated;
}

/** After a sale's allocation changes, refunds/disputes that inherit from it are re-posted (unless an admin set them manually). */
async function reallocateDependents(tx: Tx, ctx: ImportContext, chargeId: string, opts: { userId?: string | null; reason?: string | null }) {
  const deps = await tx.select().from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), eq(schema.stripeBalanceTransactions.chargeId, chargeId), inArray(schema.stripeBalanceTransactions.kind, ["REFUND", "DISPUTE", "DISPUTE_REVERSAL"])));
  for (const d of deps) {
    if (d.matchMethod === "MANUAL") continue;
    const al = await allocateDependent(tx, ctx, chargeId, d.sourceId);
    if (al.eventId === d.eventId && al.matchStatus === d.matchStatus && al.agreement?.id === d.agreementId) continue;
    await repost(tx, ctx, d, al, { ...opts, reason: opts.reason ?? "Original sale re-allocated" });
  }
}

export type ImportOutcome = { row: BtRow; created: boolean; newlyMatched: boolean };

/**
 * Import one Stripe balance transaction: mirror it, classify it, match it to an event and post it to the ledger exactly once.
 * Re-importing the same transaction is a no-op apart from refreshing Stripe's mutable fields; a previously unmatched
 * sale is matched automatically once its event exists (manual decisions are never overridden).
 */
export async function importBalanceTransaction(ctx: ImportContext, bt: Stripe.BalanceTransaction, depth = 0): Promise<ImportOutcome> {
  if (bt.object !== "balance_transaction") throw new Error("not a balance transaction");
  const kind = classifyBt(bt.type, bt.reporting_category);
  const sourceId = idOf(bt.source as string | { id: string } | null);

  // Fetch/refresh the related Stripe objects outside the DB transaction (network calls must not hold locks).
  let charge: Stripe.Charge | null = null, chargeId: string | null = null, payoutId: string | null = null, dispute: Stripe.Dispute | null = null, refund: Stripe.Refund | null = null, payout: Stripe.Payout | null = null;
  if (kind === "SALE" && sourceId) {
    charge = obj<Stripe.Charge>(bt.source, "charge") ?? ctx.charges.get(sourceId) ?? await ctx.gw.retrieveCharge(sourceId);
    chargeId = charge.id;
  } else if (kind === "REFUND" && sourceId) {
    refund = obj<Stripe.Refund>(bt.source, "refund") ?? (sourceId.startsWith("re_") || sourceId.startsWith("pyr_") ? await ctx.gw.retrieveRefund(sourceId) : null);
    chargeId = refund ? idOf(refund.charge) : null;
  } else if ((kind === "DISPUTE" || kind === "DISPUTE_REVERSAL") && sourceId) {
    dispute = obj<Stripe.Dispute>(bt.source, "dispute") ?? (sourceId.startsWith("du_") || sourceId.startsWith("dp_") ? await ctx.gw.retrieveDispute(sourceId) : null);
    chargeId = dispute ? idOf(dispute.charge) : sourceId.startsWith("ch_") || sourceId.startsWith("py_") ? sourceId : null;
  } else if ((kind === "PAYOUT" || kind === "PAYOUT_REVERSAL") && sourceId) {
    payout = obj<Stripe.Payout>(bt.source, "payout") ?? (sourceId.startsWith("po_") ? await ctx.gw.retrievePayout(sourceId) : null);
    payoutId = sourceId;
  }
  // A refund/dispute whose original sale was never imported (outside the synced range): import the original first.
  if (chargeId && kind !== "SALE" && depth === 0) {
    const [orig] = await db.select({ id: schema.stripeBalanceTransactions.id }).from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), eq(schema.stripeBalanceTransactions.chargeId, chargeId), eq(schema.stripeBalanceTransactions.kind, "SALE")));
    if (!orig) {
      const c = await ctx.gw.retrieveCharge(chargeId);
      ctx.charges.set(c.id, c);
      const obt = idOf(c.balance_transaction);
      if (obt) await importBalanceTransaction(ctx, await ctx.gw.retrieveBalanceTransaction(obt), depth + 1);
      else await upsertCharge(db, ctx.acc, c);
    }
  }
  const saleAlloc = kind === "SALE" && charge ? await allocateSale(ctx, charge, bt.currency) : null;

  return db.transaction(async (tx) => {
    await lockKey(tx, `bt:${ctx.acc.id}:${bt.id}`);
    if (charge) await upsertCharge(tx, ctx.acc, charge);
    if (refund) await upsertRefund(tx, ctx.acc, refund);
    if (payout) await upsertPayout(tx, ctx.acc, payout);
    if (charge && charge.livemode !== ctx.acc.livemode) throw new AppError("invalid_state", "Stripe returned a charge from the other mode; test and live data are never mixed.");

    const [existing] = await tx.select().from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, ctx.acc.id), eq(schema.stripeBalanceTransactions.balanceTransactionId, bt.id))).for("update");
    const al = saleAlloc ?? (kind === "REFUND" || kind === "DISPUTE" || kind === "DISPUTE_REVERSAL" ? await allocateDependent(tx, ctx, chargeId, sourceId)
      : { eventId: null, organiserId: null, agreement: null, eventCode: null, matchStatus: "NOT_APPLICABLE" as const, matchReason: kind === "OTHER" ? "UNCLASSIFIED" : null, matchMethod: null, ticketQuantity: null, original: null });
    if (dispute) await upsertDispute(tx, ctx.acc, dispute, al.matchStatus === "MATCHED" ? { eventId: al.eventId, organiserId: al.organiserId } : undefined);

    if (existing) {
      // Immutable Stripe facts never change; only status/availability and payout linkage are refreshed.
      const [row] = await tx.update(schema.stripeBalanceTransactions).set({ stripeStatus: bt.status, availableOn: ts(bt.available_on), ...(payoutId && !existing.payoutId ? { payoutId } : {}), updatedAt: new Date() }).where(eq(schema.stripeBalanceTransactions.id, existing.id)).returning();
      const auto = existing.matchMethod !== "MANUAL";
      if (auto && existing.matchStatus === "UNMATCHED" && al.matchStatus === "MATCHED") {
        const updated = await repost(tx, ctx, row!, al, { reason: "Automatically matched on re-sync" });
        await tx.insert(schema.acctMatchHistory).values({ organisationId: row!.organisationId, balanceTransactionRef: row!.id, action: "AUTO_MATCH", fromEventId: existing.eventId, toEventId: al.eventId, fromOrganiserId: existing.organiserId, toOrganiserId: al.organiserId, fromStatus: existing.reconciliationStatus, toStatus: updated.reconciliationStatus, reason: `Matched by ${al.matchMethod}` });
        return { row: updated, created: false, newlyMatched: true };
      }
      if (!existing.postedEntryId) return { row: await post(tx, ctx, row!, al), created: false, newlyMatched: false };
      return { row: row!, created: false, newlyMatched: false };
    }

    const [ins] = await tx.insert(schema.stripeBalanceTransactions).values({
      organisationId: ctx.acc.organisationId, stripeAccountRef: ctx.acc.id, livemode: ctx.acc.livemode, balanceTransactionId: bt.id, type: bt.type, reportingCategory: bt.reporting_category ?? null,
      sourceId, amount: bt.amount, fee: bt.fee, net: bt.net, currency: bt.currency, exchangeRate: bt.exchange_rate == null ? null : String(bt.exchange_rate),
      feeDetails: (bt.fee_details ?? []).map((f) => ({ amount: f.amount, currency: f.currency, type: f.type, description: f.description })), description: bt.description?.slice(0, 1000) ?? null,
      stripeStatus: bt.status, stripeCreatedAt: new Date(bt.created * 1000), availableOn: ts(bt.available_on), chargeId, payoutId, kind,
      eventCode: al.eventCode, matchStatus: al.matchStatus, reconciliationStatus: "ERROR",
    }).returning();
    const row = await post(tx, ctx, ins!, al);
    return { row, created: true, newlyMatched: false };
  });
}
