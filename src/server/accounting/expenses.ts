import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { assertClean } from "../scan";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { acctAudit, Currency, getAcctSettings, IsoDate, isLive, ModeSchema } from "./core";
import { postEntry, reverseEntry } from "./ledger";

type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const EXPENSE_CATEGORIES = ["VENUE", "ARTIST", "MARKETING", "SECURITY", "PRODUCTION", "STAFF", "TRANSPORT", "ACCOMMODATION", "OTHER"] as const;
const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const ExpenseInput = z.object({
  mode: ModeSchema, eventId: z.string().uuid(), name: z.string().trim().min(1).max(200), category: z.enum(EXPENSE_CATEGORIES),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: Currency, expenseDate: IsoDate, description: opt(2000),
  borneBy: z.enum(["BILIT", "ORGANISER"]).default("BILIT"),
});
// Explicit (not ExpenseInput.partial()): a default such as borneBy = BILIT must never be filled in on an edit.
export const ExpenseEdit = z.object({
  name: z.string().trim().min(1).max(200).optional(), category: z.enum(EXPENSE_CATEGORIES).optional(), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  expenseDate: IsoDate.optional(), description: opt(2000).optional(), borneBy: z.enum(["BILIT", "ORGANISER"]).optional(),
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters)").max(1000),
});

type ExpenseRow = typeof schema.acctEventExpenses.$inferSelect;
const auditable = (e: ExpenseRow) => ({ name: e.name, category: e.category, amount: e.amount, currency: e.currency, expenseDate: e.expenseDate, borneBy: e.borneBy, description: e.description });

/**
 * Ledger entry for an expense. Borne by Bilit: Other Expenses ← Bank (reduces Bilit profit).
 * Borne by the organiser: Organiser Payable ← Bank (Bilit paid it for them; deducted from what they are owed).
 */
async function postExpense(tx: Tx, a: Actor, e: ExpenseRow, timezone: string) {
  const [ev] = await tx.select({ name: schema.acctEvents.name, code: schema.acctEvents.code }).from(schema.acctEvents).where(eq(schema.acctEvents.id, e.eventId));
  const dims = { eventId: e.eventId, organiserId: e.organiserId };
  const debit = e.borneBy === "ORGANISER" ? "organiser_payable" as const : "other_expenses" as const;
  const { entry } = await postEntry(tx, {
    orgId: a.orgId, livemode: e.livemode, entryType: "EVENT_EXPENSE", sourceDate: new Date(`${e.expenseDate}T12:00:00Z`), entryDate: e.expenseDate, currency: e.currency,
    description: `Event expense (${e.category.toLowerCase()}) — ${e.name}${ev ? ` — ${ev.name} (${ev.code})` : ""}${e.borneBy === "ORGANISER" ? " — deducted from organiser" : ""}`,
    ...dims, sourceType: "event_expense", sourceId: e.id, idempotencyKey: `expense:${e.id}${e.revision ? `:r${e.revision}` : ""}`, createdBy: a.userId, timezone,
    postings: [{ account: debit, amount: e.amount, ...dims, memo: e.borneBy === "ORGANISER" ? "Expense deducted from organiser" : "Event expense" }, { account: "bank", amount: -e.amount, ...dims, memo: e.name.slice(0, 120) }],
  });
  return entry;
}

async function eventFor(tx: Tx, orgId: string, eventId: string) {
  const [ev] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, orgId)));
  if (!ev) throw new AppError("validation_failed", "Event not found.", [{ path: "eventId", message: "Choose an event." }]);
  return ev;
}

export async function createExpense(a: Actor, input: z.infer<typeof ExpenseInput>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const ev = await eventFor(tx, a.orgId, input.eventId);
    if (ev.currency !== input.currency) throw new AppError("validation_failed", `The event is in ${ev.currency.toUpperCase()}; record the expense in that currency.`, [{ path: "currency", message: "Must match the event currency." }]);
    if (input.borneBy === "ORGANISER" && !ev.organiserId) throw new AppError("validation_failed", "This event has no organiser to deduct the expense from.", [{ path: "borneBy", message: "Link an organiser first." }]);
    const { mode, ...rest } = input;
    const [row] = await tx.insert(schema.acctEventExpenses).values({ organisationId: a.orgId, livemode: isLive(mode), ...rest, organiserId: ev.organiserId, createdBy: a.userId }).returning();
    const entry = await postExpense(tx, a, row!, timezone);
    const [done] = await tx.update(schema.acctEventExpenses).set({ journalEntryId: entry.id }).where(eq(schema.acctEventExpenses.id, row!.id)).returning();
    await acctAudit(tx, { ...a, action: "expense.created", entity: "event_expense", entityId: row!.id, new: auditable(row!), extra: { eventId: ev.id, mode } });
    return done!;
  });
}

async function lockExpense(tx: Tx, orgId: string, id: string) {
  const [e] = await tx.select().from(schema.acctEventExpenses).where(and(eq(schema.acctEventExpenses.id, id), eq(schema.acctEventExpenses.organisationId, orgId))).for("update");
  if (!e) throw new AppError("not_found", "Expense not found");
  if (e.status === "VOIDED") throw new AppError("invalid_state", "This expense has been deleted (voided) and can no longer be changed.");
  return e;
}

export async function editExpense(a: Actor, id: string, input: z.infer<typeof ExpenseEdit>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const e = await lockExpense(tx, a.orgId, id);
    const { reason, ...patch } = input;
    const next = { ...e, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as ExpenseRow;
    if (next.borneBy === "ORGANISER" && !e.organiserId) throw new AppError("validation_failed", "This event has no organiser to deduct the expense from.", [{ path: "borneBy", message: "Link an organiser first." }]);
    const changed = (Object.keys(auditable(e)) as Array<keyof ReturnType<typeof auditable>>).filter((k) => (next[k] ?? null) !== (e[k] ?? null));
    if (!changed.length) return e;
    const reposts = changed.some((k) => ["amount", "expenseDate", "borneBy", "name", "category"].includes(k));
    let journalEntryId = e.journalEntryId, revision = e.revision;
    if (reposts) {
      if (e.journalEntryId) await reverseEntry(tx, { orgId: a.orgId, entryId: e.journalEntryId, reason: `Expense edited: ${reason}`, userId: a.userId, timezone });
      revision = e.revision + 1;
      journalEntryId = (await postExpense(tx, a, { ...next, revision }, timezone)).id;
    }
    const [row] = await tx.update(schema.acctEventExpenses).set({ name: next.name, category: next.category, amount: next.amount, expenseDate: next.expenseDate, description: next.description, borneBy: next.borneBy, revision, journalEntryId, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctEventExpenses.id, id)).returning();
    await acctAudit(tx, { ...a, action: "expense.edited", entity: "event_expense", entityId: id, old: Object.fromEntries(changed.map((k) => [k, e[k]])), new: Object.fromEntries(changed.map((k) => [k, next[k]])), reason, extra: { eventId: e.eventId, reposted: reposts } });
    return row!;
  });
}

/** Deleting an expense voids it: the record stays (marked VOIDED) and its ledger entry is reversed. */
export async function voidExpense(a: Actor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const e = await lockExpense(tx, a.orgId, id);
    if (e.journalEntryId) await reverseEntry(tx, { orgId: a.orgId, entryId: e.journalEntryId, reason: `Expense deleted: ${reason}`, userId: a.userId, timezone });
    const [row] = await tx.update(schema.acctEventExpenses).set({ status: "VOIDED", voidReason: reason, voidedBy: a.userId, voidedAt: new Date(), updatedAt: new Date() }).where(eq(schema.acctEventExpenses.id, id)).returning();
    await acctAudit(tx, { ...a, action: "expense.deleted", entity: "event_expense", entityId: id, old: auditable(e), new: { status: "VOIDED" }, reason, extra: { eventId: e.eventId } });
    return row!;
  });
}

export async function listExpenses(orgId: string, livemode: boolean, eventId: string) {
  const x = schema.acctEventExpenses;
  const rows = await db.select({ x, createdByName: schema.users.name }).from(x).leftJoin(schema.users, eq(schema.users.id, x.createdBy))
    .where(and(eq(x.organisationId, orgId), eq(x.livemode, livemode), eq(x.eventId, eventId))).orderBy(desc(x.expenseDate), desc(x.createdAt));
  return rows.map((r) => ({ ...r.x, hasReceipt: !!r.x.receiptObjectId, createdByName: r.createdByName }));
}

// ---------- receipts ----------
export const RECEIPT_TYPES: Array<{ type: string; ext: string; test: (b: Buffer) => boolean }> = [
  { type: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 1024).includes(Buffer.from("%PDF-")) },
  { type: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Attach (or replace) a receipt. Type is decided from the file content, never the client-supplied name or MIME. */
export async function attachReceipt(a: Actor, id: string, bytes: Buffer, fileName: string) {
  const cap = Math.min(10, env().MAX_UPLOAD_MB) * 1024 * 1024;
  if (!bytes.length) throw new AppError("validation_failed", "The file is empty.");
  if (bytes.length > cap) throw new AppError("payload_too_large", `The receipt is too large. The maximum is ${Math.floor(cap / 1048576)} MB.`);
  const kind = RECEIPT_TYPES.find((t) => t.test(bytes));
  if (!kind) throw new AppError("unsupported_media", "Receipts must be a PDF, PNG, JPEG or WebP file.");
  await assertClean(bytes);
  const key = objectKey(a.orgId, "receipt");
  const put = await storage().put(key, bytes, kind.type);
  return db.transaction(async (tx) => {
    const e = await lockExpense(tx, a.orgId, id);
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: kind.type }).returning();
    const name = `${fileName.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\.[^.]*$/, "").trim().slice(0, 80) || "receipt"}.${kind.ext}`;
    const [row] = await tx.update(schema.acctEventExpenses).set({ receiptObjectId: obj!.id, receiptName: name, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctEventExpenses.id, id)).returning();
    await acctAudit(tx, { ...a, action: e.receiptObjectId ? "expense.receipt_replaced" : "expense.receipt_added", entity: "event_expense", entityId: id, new: { receipt: name, sha256: put.sha256, bytes: put.sizeBytes }, extra: { eventId: e.eventId } });
    return row!;
  });
}

export async function receiptFor(orgId: string, id: string) {
  const [r] = await db.select({ key: schema.storageObjects.key, type: schema.storageObjects.contentType, name: schema.acctEventExpenses.receiptName })
    .from(schema.acctEventExpenses).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.acctEventExpenses.receiptObjectId))
    .where(and(eq(schema.acctEventExpenses.id, id), eq(schema.acctEventExpenses.organisationId, orgId), eq(schema.storageObjects.organisationId, orgId)));
  if (!r) throw new AppError("not_found", "No receipt attached");
  return r;
}
