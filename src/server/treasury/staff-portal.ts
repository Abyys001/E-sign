import type Stripe from "stripe";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { AppError } from "../errors";
import { assertClean } from "../scan";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { Currency } from "../accounting/core";
import { authorizeCard, type StaffCard } from "./access";
import type { StaffContext } from "./auth";
import { logTreasury } from "./audit";
import { safeStripeError, treasuryGateway } from "./stripe";

/**
 * Everything the authenticated staff member may do, always scoped to their own assigned card. These functions return a
 * small, fixed set of fields — never a raw Stripe object — so no unexpected data can reach the browser.
 */
const INTERVALS = ["per_authorization", "daily", "weekly", "monthly", "yearly", "all_time"] as const;

export type CardView = {
  id: string; nickname: string | null; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null;
  currency: string; type: string; status: string; frozen: boolean; canFreeze: boolean;
  spendingLimits: Array<{ amount: number; interval: string }>;
  cardholderName: string;
};

function cardView(card: StaffCard, cardholderName: string, canFreeze: boolean): CardView {
  const limits = ((card.spendingControls as { spending_limits?: Array<{ amount: number; interval: string }> } | null)?.spending_limits ?? []).map((l) => ({ amount: l.amount, interval: l.interval }));
  return {
    id: card.id, nickname: card.nickname, brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear,
    currency: card.currency, type: card.type, status: card.status, frozen: card.status === "inactive", canFreeze,
    spendingLimits: limits, cardholderName,
  };
}

export async function myCards(sc: StaffContext) {
  const rows = await db.select({ c: schema.treasuryCards, holder: schema.treasuryCardholders.name })
    .from(schema.treasuryAssignments)
    .innerJoin(schema.treasuryCards, eq(schema.treasuryCards.id, schema.treasuryAssignments.cardId))
    .innerJoin(schema.treasuryCardholders, eq(schema.treasuryCardholders.id, schema.treasuryCards.cardholderId))
    .where(and(eq(schema.treasuryAssignments.staffId, sc.staff.id), isNull(schema.treasuryAssignments.revokedAt)));
  return rows.map((r) => cardView(r.c, r.holder, sc.staff.canFreezeCard));
}

export type Activity = { id: string; kind: "authorization" | "transaction"; amount: number; currency: string; status: string; merchant: string | null; category: string | null; createdAt: number; declined: boolean; note: string | null; hasReceipt: boolean };

/** Authorisations (pending / approved / declined / reversed) and posted transactions for the staff's card, merged, newest first. */
export async function cardActivity(sc: StaffContext, cardId?: string | null): Promise<{ card: CardView; activity: Activity[] }> {
  const { card, mode, since } = await authorizeCard(sc, cardId);
  const sinceSec = Math.floor(since.getTime() / 1000);
  const [holder] = await db.select({ name: schema.treasuryCardholders.name }).from(schema.treasuryCardholders).where(eq(schema.treasuryCardholders.id, card.cardholderId));
  const gw = await treasuryGateway(sc.staff.organisationId, mode);
  let auths: Stripe.Issuing.Authorization[] = [], txns: Stripe.Issuing.Transaction[] = [];
  try { [auths, txns] = await Promise.all([gw.listAuthorizations(card.stripeCardId, 50, sinceSec), gw.listTransactions(card.stripeCardId, 50, sinceSec)]); }
  catch (e) { throw new AppError("invalid_state", `Could not load card activity: ${safeStripeError(e)}`); }
  // belt and braces: drop anything before the assignment even if the API ignored the filter
  auths = auths.filter((a) => a.created >= sinceSec); txns = txns.filter((t) => t.created >= sinceSec);
  const notes = await db.select().from(schema.treasuryExpenses).where(and(eq(schema.treasuryExpenses.cardId, card.id), eq(schema.treasuryExpenses.staffId, sc.staff.id)));
  const noteFor = (id: string) => notes.find((n) => n.stripeObjectId === id);
  const merchant = (m: Stripe.Issuing.Authorization.MerchantData | Stripe.Issuing.Transaction["merchant_data"]) => m?.name ?? null;
  const items: Activity[] = [
    ...auths.map((a): Activity => ({ id: a.id, kind: "authorization", amount: a.amount, currency: a.currency, status: a.status, merchant: merchant(a.merchant_data), category: a.merchant_data?.category ?? null, createdAt: a.created, declined: !a.approved && a.status === "closed", note: noteFor(a.id)?.note ?? null, hasReceipt: !!noteFor(a.id)?.receiptObjectId })),
    ...txns.map((t): Activity => ({ id: t.id, kind: "transaction", amount: t.amount, currency: t.currency, status: t.type, merchant: merchant(t.merchant_data), category: t.merchant_data?.category ?? null, createdAt: t.created, declined: false, note: noteFor(t.id)?.note ?? null, hasReceipt: !!noteFor(t.id)?.receiptObjectId })),
  ].sort((x, y) => y.createdAt - x.createdAt);
  return { card: cardView(card, holder?.name ?? "", sc.staff.canFreezeCard), activity: items };
}

/** Freeze (status inactive) or unfreeze (active) the staff's own card — only if policy allows it for this staff member. A canceled card can never be reactivated here. */
export async function freezeCard(sc: StaffContext, cardId: string | null, freeze: boolean) {
  const { card, mode } = await authorizeCard(sc, cardId);
  if (!sc.staff.canFreezeCard) { await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "card.freeze", resource: "card", resourceId: card.id, outcome: "DENY", ip: sc.ctx.ip }); throw new AppError("forbidden", "Freezing your card is not permitted for your account."); }
  if (card.status === "canceled") throw new AppError("invalid_state", "This card has been cancelled and cannot be changed.");
  const gw = await treasuryGateway(sc.staff.organisationId, mode);
  let updated: Stripe.Issuing.Card;
  try { updated = await gw.setCardStatus(card.stripeCardId, freeze ? "inactive" : "active"); }
  catch (e) { throw new AppError("invalid_state", `Stripe could not update the card: ${safeStripeError(e)}`); }
  await db.update(schema.treasuryCards).set({ status: updated.status, updatedAt: new Date() }).where(eq(schema.treasuryCards.id, card.id));
  await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: freeze ? "card.freeze" : "card.unfreeze", resource: "card", resourceId: card.id, outcome: "OK", ip: sc.ctx.ip });
  return { status: updated.status };
}

export const LimitRequestInput = z.object({ cardId: z.string().uuid().optional().nullable(), interval: z.enum(INTERVALS).default("monthly"), amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), reason: z.string().trim().max(1000).optional().nullable() });
/** Staff cannot change their own limit — they request a change an administrator approves. */
export async function requestLimit(sc: StaffContext, input: z.infer<typeof LimitRequestInput>) {
  const { card } = await authorizeCard(sc, input.cardId);
  const current = ((card.spendingControls as { spending_limits?: Array<{ amount: number; interval: string }> } | null)?.spending_limits ?? []).find((l) => l.interval === input.interval)?.amount ?? null;
  const [row] = await db.insert(schema.treasuryLimitRequests).values({ organisationId: sc.staff.organisationId, staffId: sc.staff.id, cardId: card.id, interval: input.interval, currentAmount: current, requestedAmount: input.amount, currency: card.currency, reason: input.reason ?? null }).returning();
  await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "limit.requested", resource: "limit_request", resourceId: row!.id, outcome: "OK", ip: sc.ctx.ip, metadata: { interval: input.interval, amount: input.amount } });
  return { id: row!.id };
}

export async function myLimitRequests(sc: StaffContext) {
  return db.select({ id: schema.treasuryLimitRequests.id, interval: schema.treasuryLimitRequests.interval, requestedAmount: schema.treasuryLimitRequests.requestedAmount, currency: schema.treasuryLimitRequests.currency, status: schema.treasuryLimitRequests.status, reason: schema.treasuryLimitRequests.reason, decisionNote: schema.treasuryLimitRequests.decisionNote, createdAt: schema.treasuryLimitRequests.createdAt })
    .from(schema.treasuryLimitRequests).where(eq(schema.treasuryLimitRequests.staffId, sc.staff.id)).orderBy(desc(schema.treasuryLimitRequests.createdAt)).limit(50);
}

export const ExpenseInput = z.object({ cardId: z.string().uuid().optional().nullable(), stripeObjectId: z.string().trim().min(3).max(120), note: z.string().trim().max(2000).optional().nullable() });
/** Attach / edit the staff's own note on one of their card's transactions. The object id is verified to belong to the card. */
export async function saveExpenseNote(sc: StaffContext, input: z.infer<typeof ExpenseInput>) {
  const { card, mode, since } = await authorizeCard(sc, input.cardId);
  await assertObjectOnCard(sc, card, mode, since, input.stripeObjectId);
  const [row] = await db.insert(schema.treasuryExpenses).values({ organisationId: sc.staff.organisationId, cardId: card.id, staffId: sc.staff.id, stripeObjectId: input.stripeObjectId, note: input.note ?? null })
    .onConflictDoUpdate({ target: [schema.treasuryExpenses.organisationId, schema.treasuryExpenses.stripeObjectId], set: { note: input.note ?? null, updatedAt: new Date() }, setWhere: eq(schema.treasuryExpenses.staffId, sc.staff.id) }).returning();
  if (!row) throw new AppError("forbidden", "That transaction is not on your card.");
  await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "expense.note", resource: "expense", resourceId: row!.id, outcome: "OK", ip: sc.ctx.ip });
  return { id: row!.id };
}

const RECEIPT_TYPES: Array<{ type: string; ext: string; test: (b: Buffer) => boolean }> = [
  { type: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 1024).includes(Buffer.from("%PDF-")) },
  { type: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

export async function uploadReceipt(sc: StaffContext, cardId: string | null, stripeObjectId: string, bytes: Buffer, fileName: string) {
  const { card, mode, since } = await authorizeCard(sc, cardId);
  await assertObjectOnCard(sc, card, mode, since, stripeObjectId);
  const cap = Math.min(15, env().MAX_UPLOAD_MB) * 1024 * 1024;
  if (!bytes.length) throw new AppError("validation_failed", "The file is empty.");
  if (bytes.length > cap) throw new AppError("payload_too_large", `The file is too large. The maximum is ${Math.floor(cap / 1048576)} MB.`);
  const kind = RECEIPT_TYPES.find((t) => t.test(bytes));
  if (!kind) throw new AppError("unsupported_media", "Upload a PDF, PNG, JPEG or WebP file.");
  await assertClean(bytes);
  const key = objectKey(sc.staff.organisationId, "receipt");
  const put = await storage().put(key, bytes, kind.type);
  return db.transaction(async (tx) => {
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: sc.staff.organisationId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: kind.type }).returning();
    const name = `${fileName.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\.[^.]*$/, "").trim().slice(0, 80) || "receipt"}.${kind.ext}`;
    const [row] = await tx.insert(schema.treasuryExpenses).values({ organisationId: sc.staff.organisationId, cardId: card.id, staffId: sc.staff.id, stripeObjectId, receiptObjectId: obj!.id, receiptName: name })
      .onConflictDoUpdate({ target: [schema.treasuryExpenses.organisationId, schema.treasuryExpenses.stripeObjectId], set: { receiptObjectId: obj!.id, receiptName: name, updatedAt: new Date() }, setWhere: eq(schema.treasuryExpenses.staffId, sc.staff.id) }).returning();
    if (!row) throw new AppError("forbidden", "That transaction is not on your card.");
    await logTreasury(tx, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "expense.receipt", resource: "expense", resourceId: row!.id, outcome: "OK", ip: sc.ctx.ip });
    return { id: row!.id, name };
  });
}

/** A receipt the staff member may view, by the transaction (Stripe object) id — only their own card's receipts. */
export async function staffReceipt(sc: StaffContext, stripeObjectId: string) {
  const [row] = await db.select({ e: schema.treasuryExpenses, obj: schema.storageObjects })
    .from(schema.treasuryExpenses).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.treasuryExpenses.receiptObjectId))
    .where(and(eq(schema.treasuryExpenses.organisationId, sc.staff.organisationId), eq(schema.treasuryExpenses.stripeObjectId, stripeObjectId), eq(schema.treasuryExpenses.staffId, sc.staff.id)));
  if (!row) throw new AppError("not_found", "Receipt not found");
  await authorizeCard(sc, row.e.cardId); // the card must still be assigned to this staff
  return { stream: await storage().getStream(row.obj.key), contentType: row.obj.contentType, name: row.e.receiptName ?? "receipt" };
}

/** Confirm a Stripe authorization/transaction id really belongs to the staff's card before storing a note against it. */
async function assertObjectOnCard(sc: StaffContext, card: StaffCard, mode: Parameters<typeof treasuryGateway>[1], since: Date, objectId: string) {
  const gw = await treasuryGateway(sc.staff.organisationId, mode);
  const kind = objectId.startsWith("iauth_") ? "auth" : objectId.startsWith("ipi_") ? "txn" : null;
  let obj: { card: string | Stripe.Issuing.Card; created: number } | null = null;
  if (kind) {
    try { obj = kind === "auth" ? await gw.retrieveAuthorization(objectId) : await gw.retrieveTransaction(objectId); }
    catch (e) { if (!(e instanceof Error && /no such|resource_missing/i.test(e.message))) throw new AppError("invalid_state", safeStripeError(e)); }
  }
  const objCard = obj ? (typeof obj.card === "string" ? obj.card : obj.card.id) : null;
  if (!obj || objCard !== card.stripeCardId || obj.created < Math.floor(since.getTime() / 1000)) {
    await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "expense.note", resource: "card", resourceId: card.id, outcome: "DENY", ip: sc.ctx.ip, metadata: { objectId } });
    throw new AppError("forbidden", "That transaction is not on your card.");
  }
}

export { Currency };
