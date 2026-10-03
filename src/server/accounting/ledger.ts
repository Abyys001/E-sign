import { and, eq } from "drizzle-orm";
import { schema, type Tx } from "@/db";
import { AppError } from "../errors";
import { ensureLedgerSetup, isPeriodClosed, localDate, postingDate, type AccountIds, type SystemAccount } from "./core";

/** A signed posting: positive = debit, negative = credit. Zero lines are dropped. */
export type Posting = { account: SystemAccount | { id: string }; amount: number; eventId?: string | null; organiserId?: string | null; memo?: string };

export type EntryInput = {
  orgId: string;
  livemode: boolean;
  entryType: string;
  sourceDate: Date;
  entryDate?: string; // explicit posting date (manual entries); otherwise derived from sourceDate + period status
  currency: string;
  description: string;
  reference?: string | null;
  eventId?: string | null;
  organiserId?: string | null;
  stripeAccountRef?: string | null;
  stripeBalanceTransactionId?: string | null;
  sourceType: string;
  sourceId?: string | null;
  agreementId?: string | null;
  idempotencyKey: string;
  reason?: string | null;
  createdBy?: string | null;
  reversesEntryId?: string | null;
  postings: Posting[];
  timezone: string;
};

export type PostResult = { entry: typeof schema.acctJournalEntries.$inferSelect; created: boolean };

/**
 * Post one balanced journal entry. Idempotent on (organisation, idempotencyKey): a repeat returns the existing entry and
 * writes nothing. Balance, immutability and closed periods are additionally enforced by database triggers.
 */
export async function postEntry(tx: Tx, e: EntryInput, accounts?: AccountIds): Promise<PostResult> {
  const [existing] = await tx.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.organisationId, e.orgId), eq(schema.acctJournalEntries.idempotencyKey, e.idempotencyKey)));
  if (existing) return { entry: existing, created: false };
  const ids = accounts ?? await ensureLedgerSetup(tx, e.orgId);
  const lines = e.postings.filter((p) => p.amount !== 0).map((p) => {
    if (!Number.isSafeInteger(p.amount)) throw new Error(`non-integer amount in posting: ${p.amount}`);
    return { accountId: typeof p.account === "string" ? ids[p.account] : p.account.id, debit: p.amount > 0 ? p.amount : 0, credit: p.amount < 0 ? -p.amount : 0, eventId: p.eventId ?? null, organiserId: p.organiserId ?? null, memo: p.memo ?? null };
  });
  const sum = lines.reduce((s, l) => s + l.debit - l.credit, 0);
  if (sum !== 0) throw new Error(`unbalanced entry ${e.idempotencyKey}: ${sum}`);
  if (lines.length < 2) throw new AppError("invalid_state", "Nothing to post: the entry has no non-zero amounts.");
  if (lines.some((l) => !l.accountId)) throw new Error("posting to unknown account");
  if (e.entryDate && (await isPeriodClosed(tx, e.orgId, e.entryDate))) throw new AppError("invalid_state", `Accounting period ${e.entryDate.slice(0, 7)} is closed. Post a dated adjustment in an open period instead.`);
  const entryDate = e.entryDate ?? await postingDate(tx, e.orgId, e.sourceDate, e.timezone);
  const ins = await tx.insert(schema.acctJournalEntries).values({
    organisationId: e.orgId, livemode: e.livemode, entryType: e.entryType, entryDate, sourceDate: e.sourceDate, currency: e.currency, description: e.description.slice(0, 500),
    reference: e.reference ?? null, eventId: e.eventId ?? null, organiserId: e.organiserId ?? null, stripeAccountRef: e.stripeAccountRef ?? null,
    stripeBalanceTransactionId: e.stripeBalanceTransactionId ?? null, sourceType: e.sourceType, sourceId: e.sourceId ?? null, agreementId: e.agreementId ?? null,
    idempotencyKey: e.idempotencyKey, reason: e.reason ?? null, createdBy: e.createdBy ?? null, reversesEntryId: e.reversesEntryId ?? null,
  }).onConflictDoNothing().returning();
  if (!ins.length) {
    const [again] = await tx.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.organisationId, e.orgId), eq(schema.acctJournalEntries.idempotencyKey, e.idempotencyKey)));
    return { entry: again!, created: false };
  }
  const entry = ins[0]!;
  await tx.insert(schema.acctJournalLines).values(lines.map((l) => ({ ...l, entryId: entry.id, organisationId: e.orgId })));
  return { entry, created: true };
}

/**
 * Reverse a posted entry with an equal-and-opposite entry (same accounts and dimensions). The original stays as it was,
 * marked REVERSED and linked to its reversal. Posted into an open period: the original date when open, otherwise today.
 */
export async function reverseEntry(tx: Tx, a: { orgId: string; entryId: string; reason: string; userId?: string | null; timezone: string; idempotencyKey?: string }) {
  const [orig] = await tx.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.id, a.entryId), eq(schema.acctJournalEntries.organisationId, a.orgId))).for("update");
  if (!orig) throw new AppError("not_found", "Journal entry not found");
  if (orig.status === "REVERSED") throw new AppError("invalid_state", "This entry has already been reversed.");
  if (orig.entryType === "REVERSAL") throw new AppError("invalid_state", "A reversal cannot itself be reversed; post a new entry instead.");
  const lines = await tx.select().from(schema.acctJournalLines).where(eq(schema.acctJournalLines.entryId, orig.id));
  const today = localDate(new Date(), a.timezone);
  const entryDate = (await isPeriodClosed(tx, a.orgId, orig.entryDate)) ? today : orig.entryDate;
  const { entry } = await postEntry(tx, {
    orgId: a.orgId, livemode: orig.livemode, entryType: "REVERSAL", sourceDate: new Date(), entryDate, currency: orig.currency,
    description: `Reversal of: ${orig.description}`.slice(0, 500), reference: orig.reference, eventId: orig.eventId, organiserId: orig.organiserId,
    stripeAccountRef: orig.stripeAccountRef, stripeBalanceTransactionId: orig.stripeBalanceTransactionId, sourceType: orig.sourceType ?? "reversal", sourceId: orig.sourceId,
    agreementId: orig.agreementId, idempotencyKey: a.idempotencyKey ?? `reversal:${orig.id}`, reason: a.reason, createdBy: a.userId ?? null, reversesEntryId: orig.id, timezone: a.timezone,
    postings: lines.map((l) => ({ account: { id: l.accountId }, amount: l.credit - l.debit, eventId: l.eventId, organiserId: l.organiserId, memo: l.memo ?? undefined })),
  });
  await tx.update(schema.acctJournalEntries).set({ status: "REVERSED", reversedByEntryId: entry.id }).where(eq(schema.acctJournalEntries.id, orig.id));
  return entry;
}
