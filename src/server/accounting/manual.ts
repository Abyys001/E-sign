import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { AppError } from "../errors";
import type { RequestContext } from "../audit";
import { acctAudit, Currency, ensureLedgerSetup, getAcctSettings, IsoDate, isLive, ModeSchema, type Mode } from "./core";
import { postEntry, reverseEntry } from "./ledger";
import { agreementOf, allocateFromSource, eventProblem, loadEvents, repost, type ImportContext } from "./importer";
import { ticketQuantity } from "./matcher";
import type { StripeAccountRow, StripeGateway } from "./stripe-gateway";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
const Reason = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(1000);

/** Context for re-posting already-imported data: no Stripe API access is needed (or allowed). */
async function offlineContext(tx: Tx, acc: StripeAccountRow): Promise<ImportContext> {
  const settings = await getAcctSettings(acc.organisationId, tx);
  const accounts = await ensureLedgerSetup(tx, acc.organisationId);
  const ev = await loadEvents(acc.organisationId, tx);
  const gw = new Proxy({}, { get: () => () => { throw new Error("Stripe API is not used for manual re-allocation"); } }) as StripeGateway;
  return { acc, gw, settings, accounts, events: ev.byCode, eventsById: ev.byId, charges: new Map(), intents: new Map() };
}

async function lockBt(tx: Tx, orgId: string, id: string) {
  const [row] = await tx.select().from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.id, id), eq(schema.stripeBalanceTransactions.organisationId, orgId))).for("update");
  if (!row) throw new AppError("not_found", "Transaction not found");
  const [acc] = await tx.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, row.stripeAccountRef));
  return { row, acc: acc! };
}

// ---------- manual matching (Stripe transaction → event → organiser) ----------
export const MatchInput = z.object({ eventId: z.string().uuid(), reason: Reason, override: z.boolean().default(false) });

export async function matchTransaction(a: Actor, btId: string, input: z.infer<typeof MatchInput>) {
  return db.transaction(async (tx) => {
    const { row, acc } = await lockBt(tx, a.orgId, btId);
    if (!["SALE", "REFUND", "DISPUTE", "DISPUTE_REVERSAL"].includes(row.kind)) throw new AppError("invalid_state", "Only sales, refunds and disputes can be assigned to an event.");
    const ctx = await offlineContext(tx, acc);
    const ev = ctx.eventsById.get(input.eventId);
    if (!ev) throw new AppError("validation_failed", "Event not found.", [{ path: "eventId", message: "Choose an event." }]);
    const problem = eventProblem(ev, row.currency);
    if (problem === "NO_ORGANISER") throw new AppError("invalid_state", "Link an organiser to this event before assigning transactions to it.");
    if (problem === "NO_AGREEMENT") throw new AppError("invalid_state", "This event has no commission agreement.");
    if (problem && !input.override) throw new AppError("precondition_failed", problem === "CURRENCY_MISMATCH" ? `The event is in ${ev.currency.toUpperCase()} but the transaction settled in ${row.currency.toUpperCase()}. Confirm the override to continue.` : "The event is not active. Confirm the override to continue.", { problem });
    let original: { amount: number; commission: number } | null = null;
    if (row.kind !== "SALE" && row.chargeId) {
      const [o] = await tx.select().from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, acc.id), eq(schema.stripeBalanceTransactions.chargeId, row.chargeId), eq(schema.stripeBalanceTransactions.kind, "SALE")));
      if (o?.matchStatus === "MATCHED" && o.eventId === ev.id) original = { amount: o.amount, commission: o.commissionAmount ?? 0 };
    }
    let qty: number | null = row.ticketQuantity;
    if (row.kind === "SALE" && row.chargeId) {
      const [c] = await tx.select({ m: schema.stripeCharges.metadata }).from(schema.stripeCharges).where(and(eq(schema.stripeCharges.stripeAccountRef, acc.id), eq(schema.stripeCharges.chargeId, row.chargeId)));
      qty = ticketQuantity(c?.m as Record<string, unknown> | undefined, null, ctx.settings.ticketQuantityKey);
    }
    const updated = await repost(tx, ctx, row, { eventId: ev.id, organiserId: ev.organiserId, agreement: ev.agreement, eventCode: ev.code, matchStatus: "MATCHED", matchReason: problem ? `OVERRIDE_${problem}` : null, matchMethod: "MANUAL", ticketQuantity: qty, original }, { userId: a.userId, reason: input.reason });
    await tx.update(schema.stripeBalanceTransactions).set({ matchedBy: a.userId, matchedAt: new Date() }).where(eq(schema.stripeBalanceTransactions.id, row.id));
    await tx.insert(schema.acctMatchHistory).values({ organisationId: a.orgId, balanceTransactionRef: row.id, action: "MATCH", fromEventId: row.eventId, toEventId: ev.id, fromOrganiserId: row.organiserId, toOrganiserId: ev.organiserId, fromStatus: row.reconciliationStatus, toStatus: updated.reconciliationStatus, reason: input.reason, userId: a.userId });
    await acctAudit(tx, { ...a, action: "transaction.matched", entity: "stripe_balance_transaction", entityId: row.id, old: { eventId: row.eventId, organiserId: row.organiserId, status: row.reconciliationStatus }, new: { eventId: ev.id, organiserId: ev.organiserId, status: updated.reconciliationStatus, override: problem }, reason: input.reason, extra: { balanceTransactionId: row.balanceTransactionId } });
    return updated;
  });
}

export async function unmatchTransaction(a: Actor, btId: string, reason: string) {
  return db.transaction(async (tx) => {
    const { row, acc } = await lockBt(tx, a.orgId, btId);
    if (row.matchStatus !== "MATCHED") throw new AppError("invalid_state", "This transaction is not assigned to an event.");
    const ctx = await offlineContext(tx, acc);
    const updated = await repost(tx, ctx, row, { eventId: null, organiserId: null, agreement: null, eventCode: row.eventCode, matchStatus: "UNMATCHED", matchReason: "MANUAL_UNMATCH", matchMethod: "MANUAL", ticketQuantity: row.ticketQuantity, original: null }, { userId: a.userId, reason });
    await tx.insert(schema.acctMatchHistory).values({ organisationId: a.orgId, balanceTransactionRef: row.id, action: "UNMATCH", fromEventId: row.eventId, fromOrganiserId: row.organiserId, fromStatus: row.reconciliationStatus, toStatus: updated.reconciliationStatus, reason, userId: a.userId });
    await acctAudit(tx, { ...a, action: "transaction.unmatched", entity: "stripe_balance_transaction", entityId: row.id, old: { eventId: row.eventId, organiserId: row.organiserId }, new: null, reason });
    return updated;
  });
}

export const ClassifyInput = z.object({ accountId: z.string().uuid(), reason: Reason });
/** Give unclassified Stripe activity (reserves, transfers, adjustments…) a ledger account; moves it out of suspense. */
export async function classifyTransaction(a: Actor, btId: string, input: z.infer<typeof ClassifyInput>) {
  return db.transaction(async (tx) => {
    const { row, acc } = await lockBt(tx, a.orgId, btId);
    if (row.kind !== "OTHER") throw new AppError("invalid_state", "Only unclassified Stripe activity can be classified manually.");
    const [account] = await tx.select().from(schema.acctAccounts).where(and(eq(schema.acctAccounts.id, input.accountId), eq(schema.acctAccounts.organisationId, a.orgId)));
    if (!account || ["stripe_balance", "organiser_payable"].includes(account.systemKey ?? "")) throw new AppError("validation_failed", "Choose a different account.", [{ path: "accountId", message: "Not allowed for classification." }]);
    const [withAcct] = await tx.update(schema.stripeBalanceTransactions).set({ classificationAccountId: account.id }).where(eq(schema.stripeBalanceTransactions.id, row.id)).returning();
    const ctx = await offlineContext(tx, acc);
    const updated = await repost(tx, ctx, withAcct!, { eventId: null, organiserId: null, agreement: null, eventCode: null, matchStatus: "NOT_APPLICABLE", matchReason: null, matchMethod: "MANUAL", ticketQuantity: null, original: null }, { userId: a.userId, reason: input.reason });
    await tx.insert(schema.acctMatchHistory).values({ organisationId: a.orgId, balanceTransactionRef: row.id, action: "CLASSIFY", fromStatus: row.reconciliationStatus, toStatus: updated.reconciliationStatus, reason: `${account.code} ${account.name}: ${input.reason}`, userId: a.userId });
    await acctAudit(tx, { ...a, action: "transaction.classified", entity: "stripe_balance_transaction", entityId: row.id, old: { accountId: row.classificationAccountId }, new: { accountId: account.id, code: account.code }, reason: input.reason });
    return updated;
  });
}

// ---------- organiser payments ----------
export const PaymentInput = z.object({
  mode: ModeSchema, organiserId: z.string().uuid(), eventId: z.string().uuid().optional().nullable(), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: Currency,
  paymentDate: IsoDate, bankReference: z.string().trim().max(120).optional().nullable(), method: z.enum(["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"]).default("BANK_TRANSFER"),
  notes: z.string().trim().max(2000).optional().nullable(), status: z.enum(["PENDING", "PAID"]).default("PAID"),
});

async function postPayment(tx: Tx, a: Actor, p: typeof schema.acctOrganiserPayments.$inferSelect, tz: string) {
  const [o] = await tx.select({ name: schema.acctOrganisers.name }).from(schema.acctOrganisers).where(eq(schema.acctOrganisers.id, p.organiserId));
  const { entry } = await postEntry(tx, {
    orgId: a.orgId, livemode: p.livemode, entryType: "ORGANISER_PAYMENT", sourceDate: new Date(`${p.paymentDate}T12:00:00Z`), entryDate: p.paymentDate, currency: p.currency,
    description: `Payment to organiser ${o?.name ?? ""}${p.bankReference ? ` — ${p.bankReference}` : ""}${p.revision ? ` (revision ${p.revision})` : ""}`, reference: p.bankReference, eventId: p.eventId, organiserId: p.organiserId,
    sourceType: "organiser_payment", sourceId: p.id, idempotencyKey: `orgpay:${p.id}${p.revision ? `:r${p.revision}` : ""}`, createdBy: a.userId, timezone: tz,
    postings: [{ account: "organiser_payable", amount: p.amount, eventId: p.eventId, organiserId: p.organiserId, memo: "Paid to organiser" }, { account: "bank", amount: -p.amount, eventId: p.eventId, organiserId: p.organiserId, memo: p.method }],
  });
  return entry;
}

/** Record money Bilit paid an organiser. A separate ledger entry; Stripe data is never touched. */
export async function recordOrganiserPayment(a: Actor, input: z.infer<typeof PaymentInput>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const [o] = await tx.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, input.organiserId), eq(schema.acctOrganisers.organisationId, a.orgId)));
    if (!o) throw new AppError("validation_failed", "Organiser not found.", [{ path: "organiserId", message: "Choose an organiser." }]);
    if (input.eventId) {
      const [e] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, input.eventId), eq(schema.acctEvents.organisationId, a.orgId)));
      if (!e || e.organiserId !== o.id) throw new AppError("validation_failed", "That event does not belong to this organiser.", [{ path: "eventId", message: "Choose one of the organiser's events." }]);
      if (e.currency !== input.currency) throw new AppError("validation_failed", `The event is in ${e.currency.toUpperCase()}.`, [{ path: "currency", message: "Currency must match the event." }]);
    }
    const { mode, ...rest } = input;
    const [p] = await tx.insert(schema.acctOrganiserPayments).values({ organisationId: a.orgId, livemode: isLive(mode), ...rest, eventId: rest.eventId ?? null, bankReference: rest.bankReference ?? null, notes: rest.notes ?? null, createdBy: a.userId }).returning();
    let row = p!;
    if (row.status === "PAID") {
      const entry = await postPayment(tx, a, row, timezone);
      [row] = await tx.update(schema.acctOrganiserPayments).set({ journalEntryId: entry.id }).where(eq(schema.acctOrganiserPayments.id, row.id)).returning() as [typeof row];
    }
    await acctAudit(tx, { ...a, action: "organiser_payment.recorded", entity: "organiser_payment", entityId: row.id, new: { ...rest, mode } });
    return row;
  });
}

export async function markPaymentPaid(a: Actor, id: string, paymentDate?: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const [p] = await tx.select().from(schema.acctOrganiserPayments).where(and(eq(schema.acctOrganiserPayments.id, id), eq(schema.acctOrganiserPayments.organisationId, a.orgId))).for("update");
    if (!p) throw new AppError("not_found", "Payment not found");
    if (p.status !== "PENDING") throw new AppError("invalid_state", "Only pending payments can be marked as paid.");
    const [withDate] = await tx.update(schema.acctOrganiserPayments).set({ status: "PAID", paymentDate: paymentDate ?? p.paymentDate, updatedAt: new Date() }).where(eq(schema.acctOrganiserPayments.id, id)).returning();
    const entry = await postPayment(tx, a, withDate!, timezone);
    const [row] = await tx.update(schema.acctOrganiserPayments).set({ journalEntryId: entry.id }).where(eq(schema.acctOrganiserPayments.id, id)).returning();
    await acctAudit(tx, { ...a, action: "organiser_payment.paid", entity: "organiser_payment", entityId: id, old: { status: "PENDING" }, new: { status: "PAID", paymentDate: row!.paymentDate }, extra: { eventId: p.eventId, amount: p.amount, currency: p.currency } });
    return row!;
  });
}

/** Voiding never deletes: the payment is marked VOIDED and its ledger entry is reversed. */
export async function voidOrganiserPayment(a: Actor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const [p] = await tx.select().from(schema.acctOrganiserPayments).where(and(eq(schema.acctOrganiserPayments.id, id), eq(schema.acctOrganiserPayments.organisationId, a.orgId))).for("update");
    if (!p) throw new AppError("not_found", "Payment not found");
    if (p.status === "VOIDED") throw new AppError("invalid_state", "This payment is already voided.");
    const rev = p.journalEntryId ? await reverseEntry(tx, { orgId: a.orgId, entryId: p.journalEntryId, reason, userId: a.userId, timezone }) : null;
    const [row] = await tx.update(schema.acctOrganiserPayments).set({ status: "VOIDED", voidEntryId: rev?.id ?? null, voidReason: reason, voidedBy: a.userId, voidedAt: new Date(), updatedAt: new Date() }).where(eq(schema.acctOrganiserPayments.id, id)).returning();
    await acctAudit(tx, { ...a, action: "organiser_payment.voided", entity: "organiser_payment", entityId: id, old: { status: p.status }, new: { status: "VOIDED" }, reason, extra: { eventId: p.eventId, amount: p.amount, currency: p.currency, reference: p.bankReference } });
    return row!;
  });
}

// ---------- manual adjustments ----------
export const AdjustmentInput = z.object({
  mode: ModeSchema, date: IsoDate, currency: Currency, amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  debitAccountId: z.string().uuid(), creditAccountId: z.string().uuid(), eventId: z.string().uuid().optional().nullable(), organiserId: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(3).max(300), reason: Reason, reference: z.string().trim().max(120).optional().nullable(),
});

/** A manual double-entry adjustment (e.g. sponsorship income, venue cost). Stripe transactions are never altered. */
export async function createAdjustment(a: Actor, input: z.infer<typeof AdjustmentInput>, idempotencyKey: string) {
  if (input.debitAccountId === input.creditAccountId) throw new AppError("validation_failed", "Debit and credit accounts must differ.", [{ path: "creditAccountId", message: "Choose a different account." }]);
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const accs = await tx.select().from(schema.acctAccounts).where(eq(schema.acctAccounts.organisationId, a.orgId));
    const dr = accs.find((x) => x.id === input.debitAccountId), cr = accs.find((x) => x.id === input.creditAccountId);
    if (!dr || !cr) throw new AppError("validation_failed", "Unknown account.", [{ path: !dr ? "debitAccountId" : "creditAccountId", message: "Choose an account." }]);
    let organiserId = input.organiserId ?? null;
    if (input.eventId) {
      const [e] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, input.eventId), eq(schema.acctEvents.organisationId, a.orgId)));
      if (!e) throw new AppError("validation_failed", "Event not found.", [{ path: "eventId", message: "Choose an event." }]);
      if (organiserId && e.organiserId && organiserId !== e.organiserId) throw new AppError("validation_failed", "That organiser is not linked to the event.", [{ path: "organiserId", message: "Mismatch" }]);
      organiserId ??= e.organiserId;
    }
    if (organiserId) {
      const [o] = await tx.select({ id: schema.acctOrganisers.id }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, organiserId), eq(schema.acctOrganisers.organisationId, a.orgId)));
      if (!o) throw new AppError("validation_failed", "Organiser not found.", [{ path: "organiserId", message: "Choose an organiser." }]);
    }
    if ([dr, cr].some((x) => x.systemKey === "organiser_payable") && !organiserId) throw new AppError("validation_failed", "Adjustments to organiser payables need an organiser.", [{ path: "organiserId", message: "Required for this account." }]);
    if ([dr, cr].some((x) => x.systemKey === "stripe_balance")) throw new AppError("validation_failed", "The Stripe Balance account only changes through imported Stripe transactions.", [{ path: "debitAccountId", message: "Not allowed" }]);
    const dims = { eventId: input.eventId ?? null, organiserId };
    const { entry, created } = await postEntry(tx, {
      orgId: a.orgId, livemode: isLive(input.mode), entryType: "ADJUSTMENT", sourceDate: new Date(`${input.date}T12:00:00Z`), entryDate: input.date, currency: input.currency,
      description: input.description, reference: input.reference ?? null, ...dims, sourceType: "adjustment", idempotencyKey: `adj:${idempotencyKey}`, reason: input.reason, createdBy: a.userId, timezone,
      postings: [{ account: { id: dr.id }, amount: input.amount, ...dims }, { account: { id: cr.id }, amount: -input.amount, ...dims }],
    });
    if (created) await acctAudit(tx, { ...a, action: "adjustment.created", entity: "journal_entry", entityId: entry.id, new: { ...input, debit: dr.code, credit: cr.code }, reason: input.reason });
    return entry;
  });
}

/** Reverse a manual entry (adjustment or event fee). Stripe postings are corrected by re-matching, payments by voiding. */
export async function reverseManualEntry(a: Actor, entryId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.id, entryId), eq(schema.acctJournalEntries.organisationId, a.orgId)));
    if (!e) throw new AppError("not_found", "Journal entry not found");
    if (!["ADJUSTMENT", "EVENT_FEE"].includes(e.entryType)) throw new AppError("invalid_state", e.entryType === "ORGANISER_PAYMENT" ? "Void the organiser payment instead." : "Stripe-derived entries are corrected by re-assigning the transaction, not by manual reversal.");
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const rev = await reverseEntry(tx, { orgId: a.orgId, entryId, reason, userId: a.userId, timezone });
    await acctAudit(tx, { ...a, action: "entry.reversed", entity: "journal_entry", entityId: entryId, new: { reversalId: rev.id }, reason });
    return rev;
  });
}

/** Charge the agreed one-off event fee to the organiser (once per agreement version). */
export async function postEventFee(a: Actor, eventId: string, mode: Mode, date: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const [r] = await tx.select({ e: schema.acctEvents, ag: schema.acctAgreements }).from(schema.acctEvents).innerJoin(schema.acctAgreements, eq(schema.acctAgreements.id, schema.acctEvents.currentAgreementId)).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, a.orgId)));
    if (!r) throw new AppError("not_found", "Event not found");
    const ag = agreementOf(r.ag);
    if (!ag.fixedEventFee) throw new AppError("invalid_state", "The current agreement has no fixed event fee.");
    if (!r.e.organiserId) throw new AppError("invalid_state", "Link an organiser to the event first.");
    const dims = { eventId, organiserId: r.e.organiserId };
    const { entry, created } = await postEntry(tx, {
      orgId: a.orgId, livemode: isLive(mode), entryType: "EVENT_FEE", sourceDate: new Date(`${date}T12:00:00Z`), entryDate: date, currency: r.e.currency,
      description: `Fixed event fee — ${r.e.name} (${r.e.code})`, ...dims, agreementId: ag.id, sourceType: "event_fee", sourceId: ag.id,
      idempotencyKey: `eventfee:${eventId}:${ag.id}:${mode}`, createdBy: a.userId, timezone,
      postings: [{ account: "organiser_payable", amount: ag.fixedEventFee, ...dims, memo: "Event fee charged to organiser" }, { account: "bilit_commission", amount: -ag.fixedEventFee, ...dims, memo: "Event fee" }],
    });
    if (!created) throw new AppError("conflict", "The event fee for this agreement version has already been charged.");
    await acctAudit(tx, { ...a, action: "event_fee.posted", entity: "event", entityId: eventId, extra: { eventId }, new: { amount: ag.fixedEventFee, agreementVersion: r.ag.version, mode } });
    return entry;
  });
}

// ---------- accounting periods ----------
export const PeriodInput = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), action: z.enum(["close", "reopen"]), reason: Reason });
export async function setPeriodStatus(a: Actor, input: z.infer<typeof PeriodInput>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.acctPeriods).where(and(eq(schema.acctPeriods.organisationId, a.orgId), eq(schema.acctPeriods.period, input.period))).for("update");
    const status = input.action === "close" ? "CLOSED" : "OPEN";
    if ((before?.status ?? "OPEN") === status) throw new AppError("invalid_state", `Period ${input.period} is already ${status.toLowerCase()}.`);
    const values = { status, closedBy: status === "CLOSED" ? a.userId : null, closedAt: status === "CLOSED" ? new Date() : null, notes: input.reason, updatedAt: new Date() };
    const [row] = before
      ? await tx.update(schema.acctPeriods).set(values).where(eq(schema.acctPeriods.id, before.id)).returning()
      : await tx.insert(schema.acctPeriods).values({ organisationId: a.orgId, period: input.period, ...values }).returning();
    await acctAudit(tx, { ...a, action: `period.${input.action === "close" ? "closed" : "reopened"}`, entity: "period", entityId: input.period, old: { status: before?.status ?? "OPEN" }, new: { status }, reason: input.reason });
    return row!;
  });
}

// ---------- automatic re-matching of already-imported sales ----------
/**
 * Re-run event-code matching for unmatched sales from their stored Stripe description/metadata (no Stripe API calls).
 * Sales whose event now exists are re-posted (reversal + new posting); for the rest the detected code/reason is refreshed.
 * Manual decisions are never touched. Called after events or matching rules change, and by reconciliation runs.
 */
export async function rematchUnmatched(orgId: string, opts: { userId?: string | null } = {}) {
  const accs = await db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.organisationId, orgId));
  let matched = 0, updated = 0;
  for (const acc of accs) {
    const rows = await db.select({ id: schema.stripeBalanceTransactions.id }).from(schema.stripeBalanceTransactions)
      .where(and(eq(schema.stripeBalanceTransactions.stripeAccountRef, acc.id), eq(schema.stripeBalanceTransactions.kind, "SALE"), eq(schema.stripeBalanceTransactions.matchStatus, "UNMATCHED"), sql`coalesce(${schema.stripeBalanceTransactions.matchMethod}, '') <> 'MANUAL'`)).limit(20_000);
    for (const { id } of rows) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.id, id)).for("update");
        if (!row || row.matchStatus !== "UNMATCHED" || row.matchMethod === "MANUAL") return;
        const [c] = row.chargeId ? await tx.select({ d: schema.stripeCharges.description, m: schema.stripeCharges.metadata }).from(schema.stripeCharges).where(and(eq(schema.stripeCharges.stripeAccountRef, acc.id), eq(schema.stripeCharges.chargeId, row.chargeId))) : [];
        const ctx = await offlineContext(tx, acc);
        const al = allocateFromSource(ctx, { description: c?.d ?? row.description, metadata: (c?.m as Record<string, unknown>) ?? {} }, row.currency);
        if (al.matchStatus === "MATCHED") {
          const up = await repost(tx, ctx, row, al, { userId: opts.userId, reason: "Automatically matched after event/rule change" });
          await tx.insert(schema.acctMatchHistory).values({ organisationId: orgId, balanceTransactionRef: row.id, action: "AUTO_MATCH", fromEventId: row.eventId, toEventId: al.eventId, fromOrganiserId: row.organiserId, toOrganiserId: al.organiserId, fromStatus: row.reconciliationStatus, toStatus: up.reconciliationStatus, reason: `Matched by ${al.matchMethod}`, userId: opts.userId ?? null });
          matched++;
        } else if (al.eventCode !== row.eventCode || al.matchReason !== row.matchReason || al.eventId !== row.eventId) {
          await tx.update(schema.stripeBalanceTransactions).set({ eventCode: al.eventCode, matchReason: al.matchReason, matchMethod: al.matchMethod, eventId: al.eventId, reconciliationStatus: al.matchReason === "AMBIGUOUS" ? "DUPLICATE" : "UNMATCHED", updatedAt: new Date() }).where(eq(schema.stripeBalanceTransactions.id, row.id));
          updated++;
        }
      });
    }
  }
  return { matched, updated };
}

// ---------- organiser payment edits (re-post: reversal of the old entry + a new entry; the history stays) ----------
export const PaymentEdit = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), paymentDate: IsoDate.optional(),
  bankReference: z.string().trim().max(120).optional().nullable(), method: z.enum(["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"]).optional(),
  notes: z.string().trim().max(2000).optional().nullable(), eventId: z.string().uuid().optional().nullable(), reason: Reason,
});

export async function editOrganiserPayment(a: Actor, id: string, input: z.infer<typeof PaymentEdit>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const [p] = await tx.select().from(schema.acctOrganiserPayments).where(and(eq(schema.acctOrganiserPayments.id, id), eq(schema.acctOrganiserPayments.organisationId, a.orgId))).for("update");
    if (!p) throw new AppError("not_found", "Payment not found");
    if (p.status === "VOIDED") throw new AppError("invalid_state", "A voided payment cannot be edited.");
    const { reason, ...patch } = input;
    if (patch.eventId) {
      const [e] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, patch.eventId), eq(schema.acctEvents.organisationId, a.orgId)));
      if (!e || e.organiserId !== p.organiserId) throw new AppError("validation_failed", "That event does not belong to this organiser.", [{ path: "eventId", message: "Choose one of the organiser's events." }]);
      if (e.currency !== p.currency) throw new AppError("validation_failed", `The event is in ${e.currency.toUpperCase()}.`, [{ path: "eventId", message: "Currency must match the payment." }]);
    }
    const next = { ...p, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as typeof p;
    const keys = ["amount", "paymentDate", "bankReference", "method", "notes", "eventId"] as const;
    const changed = keys.filter((k) => (next[k] ?? null) !== (p[k] ?? null));
    if (!changed.length) return p;
    // Anything that changes the ledger (amount, date, event, reference, method) re-posts; a notes-only edit does not.
    const reposts = p.status === "PAID" && changed.some((k) => k !== "notes");
    let journalEntryId = p.journalEntryId, revision = p.revision;
    if (reposts) {
      if (p.journalEntryId) await reverseEntry(tx, { orgId: a.orgId, entryId: p.journalEntryId, reason: `Payment edited: ${reason}`, userId: a.userId, timezone, idempotencyKey: `reversal:${p.journalEntryId}` });
      revision = p.revision + 1;
      const entry = await postPayment(tx, a, { ...next, revision }, timezone);
      journalEntryId = entry.id;
    }
    const [row] = await tx.update(schema.acctOrganiserPayments).set({ amount: next.amount, paymentDate: next.paymentDate, bankReference: next.bankReference, method: next.method, notes: next.notes, eventId: next.eventId, revision, journalEntryId, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctOrganiserPayments.id, id)).returning();
    await acctAudit(tx, { ...a, action: "organiser_payment.edited", entity: "organiser_payment", entityId: id, old: Object.fromEntries(changed.map((k) => [k, p[k]])), new: Object.fromEntries(changed.map((k) => [k, next[k]])), reason, extra: { eventId: next.eventId ?? p.eventId, organiserId: p.organiserId, currency: p.currency, reposted: reposts } });
    return row!;
  });
}

// ---------- booking fee (per event) ----------
export const BookingFeeInput = z.object({ percentBps: z.number().int().min(0).max(10_000), applyToExisting: z.boolean().default(true), reason: Reason });

/**
 * Change an event's booking fee %. A new agreement version is created (other terms unchanged). With `applyToExisting`
 * every sale already booked to the event (and its refunds/disputes) is re-posted with the new rate: the old postings are
 * reversed, never edited, so the change is visible in the ledger and the audit log.
 */
export async function setBookingFee(a: Actor, eventId: string, input: z.infer<typeof BookingFeeInput>) {
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, a.orgId))).for("update");
    if (!ev) throw new AppError("not_found", "Event not found");
    const [prev] = ev.currentAgreementId ? await tx.select().from(schema.acctAgreements).where(eq(schema.acctAgreements.id, ev.currentAgreementId)) : [];
    if (prev && prev.percentBps === input.percentBps && !input.applyToExisting) throw new AppError("invalid_state", "The booking fee is already set to that percentage.");
    const [m] = await tx.select({ v: sql<number>`coalesce(max(${schema.acctAgreements.version}), 0)::int` }).from(schema.acctAgreements).where(eq(schema.acctAgreements.eventId, eventId));
    const terms = prev ? { percentBasis: prev.percentBasis, fixedPerTicket: prev.fixedPerTicket, fixedEventFee: prev.fixedEventFee, stripeFeesBorneBy: prev.stripeFeesBorneBy, chargebacksBorneBy: prev.chargebacksBorneBy, refundsReverseCommission: prev.refundsReverseCommission } : {};
    const [ag] = await tx.insert(schema.acctAgreements).values({ organisationId: a.orgId, eventId, version: (m?.v ?? 0) + 1, percentBps: input.percentBps, ...terms, notes: `Booking fee changed: ${input.reason}`.slice(0, 1000), createdBy: a.userId }).returning();
    await tx.update(schema.acctEvents).set({ currentAgreementId: ag!.id, updatedAt: new Date() }).where(eq(schema.acctEvents.id, eventId));
    let reposted = 0;
    if (input.applyToExisting) {
      const bt = schema.stripeBalanceTransactions;
      const accs = await tx.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.organisationId, a.orgId));
      for (const acc of accs) {
        const ctx = await offlineContext(tx, acc);
        const agreement = ctx.eventsById.get(eventId)!.agreement!;
        const sales = await tx.select().from(bt).where(and(eq(bt.stripeAccountRef, acc.id), eq(bt.eventId, eventId), eq(bt.matchStatus, "MATCHED"), eq(bt.kind, "SALE"))).for("update");
        for (const row of sales) {
          await repost(tx, ctx, row, { eventId, organiserId: row.organiserId, agreement, eventCode: row.eventCode, matchStatus: "MATCHED", matchReason: row.matchReason, matchMethod: row.matchMethod, ticketQuantity: row.ticketQuantity, original: null }, { userId: a.userId, reason: `Booking fee changed to ${input.percentBps / 100}%: ${input.reason}` });
          reposted++;
        }
        // Refunds/disputes assigned by hand are not re-derived automatically; bring them onto the new rate too.
        const manual = await tx.select().from(bt).where(and(eq(bt.stripeAccountRef, acc.id), eq(bt.eventId, eventId), eq(bt.matchStatus, "MATCHED"), sql`${bt.kind} <> 'SALE'`, sql`${bt.agreementId} is distinct from ${ag!.id}`)).for("update");
        for (const row of manual) {
          const [o] = row.chargeId ? await tx.select().from(bt).where(and(eq(bt.stripeAccountRef, acc.id), eq(bt.chargeId, row.chargeId), eq(bt.kind, "SALE"))) : [];
          await repost(tx, ctx, row, { eventId, organiserId: row.organiserId, agreement, eventCode: row.eventCode, matchStatus: "MATCHED", matchReason: row.matchReason, matchMethod: row.matchMethod, ticketQuantity: row.ticketQuantity, original: o?.eventId === eventId ? { amount: o.amount, commission: o.commissionAmount ?? 0 } : null }, { userId: a.userId, reason: `Booking fee changed: ${input.reason}` });
          reposted++;
        }
      }
    }
    await acctAudit(tx, { ...a, action: "booking_fee.changed", entity: "event", entityId: eventId, old: { percentBps: prev?.percentBps ?? null, version: prev?.version ?? null }, new: { percentBps: input.percentBps, version: ag!.version }, reason: input.reason, extra: { eventId, eventName: ev.name, applyToExisting: input.applyToExisting, reposted } });
    return { agreement: ag!, reposted };
  });
}
