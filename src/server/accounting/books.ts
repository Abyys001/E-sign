import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { assertClean } from "../scan";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { acctAudit, Currency, ensureLedgerSetup, getAcctSettings, IsoDate, isLive, ModeSchema, type Mode, type SystemAccount } from "./core";
import { postEntry, reverseEntry } from "./ledger";
import { findDuplicateBills, getMonitorSettings } from "./monitor";

/**
 * Bookkeeping: supplier invoices (bills) and manual expenses. Every document is posted to the double-entry ledger:
 *   bill recorded   Dr expense account (net) + Dr Input VAT (vat)  /  Cr Accounts Payable (total)
 *   bill paid       Dr Accounts Payable (total)                    /  Cr Bank | Cash | Owed to employees
 *   expense         Dr expense account (net) + Dr Input VAT (vat)  /  Cr Bank | Cash | Owed to employees
 * Editing re-posts (reversal + new entry), deleting voids (record kept, entries reversed). Amounts stay in the
 * document's own currency.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const Reason = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(1000);
export const PAID_FROM = ["BANK", "CARD", "CASH", "EMPLOYEE"] as const;
const creditFor = (from: string | null): SystemAccount => (from === "CASH" ? "cash" : from === "EMPLOYEE" ? "employee_reimbursements" : "bank");

export const BillInput = z.object({
  mode: ModeSchema, kind: z.enum(["BILL", "EXPENSE"]),
  supplierName: z.string().trim().min(1).max(200), supplierVat: opt(60), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional().nullable(),
  invoiceNumber: opt(80), invoiceDate: IsoDate, dueDate: IsoDate.optional().nullable(), currency: Currency,
  netAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), vatAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  accountId: z.string().uuid(), eventId: z.string().uuid().optional().nullable(), description: opt(2000),
  paidFrom: z.enum(PAID_FROM).optional().nullable(), paidDate: IsoDate.optional().nullable(), paymentReference: opt(120),
  allowDuplicate: z.boolean().optional(), // the user saw the duplicate warning and confirmed it is a different document
}).refine((b) => b.netAmount + b.vatAmount > 0, { message: "The total must be more than zero", path: ["netAmount"] });
export const BillEdit = z.object({
  supplierName: z.string().trim().min(1).max(200).optional(), supplierVat: opt(60).optional(), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional().nullable(),
  invoiceNumber: opt(80).optional(), invoiceDate: IsoDate.optional(), dueDate: IsoDate.optional().nullable(),
  netAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), vatAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  accountId: z.string().uuid().optional(), eventId: z.string().uuid().optional().nullable(), description: opt(2000).optional(), paidFrom: z.enum(PAID_FROM).optional().nullable(), reason: Reason,
});
export const BillPay = z.object({ paidDate: IsoDate, paidFrom: z.enum(PAID_FROM).default("BANK"), paymentReference: opt(120) });

type Bill = typeof schema.acctBills.$inferSelect;
const auditable = (b: Bill) => ({ kind: b.kind, supplierName: b.supplierName, invoiceNumber: b.invoiceNumber, invoiceDate: b.invoiceDate, currency: b.currency, netAmount: b.netAmount, vatAmount: b.vatAmount, totalAmount: b.totalAmount, accountId: b.accountId, eventId: b.eventId, status: b.status });

async function expenseAccount(tx: Tx, orgId: string, accountId: string) {
  const [a] = await tx.select().from(schema.acctAccounts).where(and(eq(schema.acctAccounts.id, accountId), eq(schema.acctAccounts.organisationId, orgId)));
  if (!a || a.type !== "EXPENSE" || ["stripe_fees", "stripe_fee_recharges", "refunds", "chargebacks", "wages", "employer_payroll_costs"].includes(a.systemKey ?? ""))
    throw new AppError("validation_failed", "Choose an expense category.", [{ path: "accountId", message: "Not an expense category" }]);
  return a;
}

async function checkEvent(tx: Tx, orgId: string, eventId: string | null | undefined, currency: string) {
  if (!eventId) return null;
  const [e] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, orgId)));
  if (!e) throw new AppError("validation_failed", "Event not found.", [{ path: "eventId", message: "Choose an event." }]);
  if (e.currency !== currency) throw new AppError("validation_failed", `The event is in ${e.currency.toUpperCase()}; link only documents in that currency.`, [{ path: "eventId", message: "Currency differs" }]);
  return e;
}

async function postRecord(tx: Tx, a: Actor, b: Bill, timezone: string) {
  const dims = { eventId: b.eventId, organiserId: null };
  const label = `${b.kind === "BILL" ? "Supplier invoice" : "Expense"} — ${b.supplierName}${b.invoiceNumber ? ` #${b.invoiceNumber}` : ""}`;
  const credit: SystemAccount = b.kind === "BILL" ? "accounts_payable" : creditFor(b.paidFrom);
  const { entry } = await postEntry(tx, {
    orgId: a.orgId, livemode: b.livemode, entryType: b.kind === "BILL" ? "SUPPLIER_INVOICE" : "EXPENSE", sourceDate: new Date(`${b.invoiceDate}T12:00:00Z`), entryDate: b.invoiceDate, currency: b.currency,
    description: label, reference: b.invoiceNumber, eventId: b.eventId, sourceType: "bill", sourceId: b.id, idempotencyKey: `bill:${b.id}${b.revision ? `:r${b.revision}` : ""}`, createdBy: a.userId, timezone,
    postings: [{ account: { id: b.accountId }, amount: b.netAmount, ...dims, memo: b.description?.slice(0, 120) ?? "Net" }, { account: "vat_input", amount: b.vatAmount, ...dims, memo: "VAT" }, { account: credit, amount: -b.totalAmount, ...dims, memo: b.supplierName.slice(0, 120) }],
  });
  return entry;
}

async function postPayment(tx: Tx, a: Actor, b: Bill, timezone: string) {
  const { entry } = await postEntry(tx, {
    orgId: a.orgId, livemode: b.livemode, entryType: "SUPPLIER_PAYMENT", sourceDate: new Date(`${b.paidDate}T12:00:00Z`), entryDate: b.paidDate!, currency: b.currency,
    description: `Payment to ${b.supplierName}${b.invoiceNumber ? ` for #${b.invoiceNumber}` : ""}`, reference: b.paymentReference, eventId: b.eventId, sourceType: "bill_payment", sourceId: b.id,
    idempotencyKey: `billpay:${b.id}${b.revision ? `:r${b.revision}` : ""}`, createdBy: a.userId, timezone,
    postings: [{ account: "accounts_payable", amount: b.totalAmount, eventId: b.eventId, memo: b.supplierName.slice(0, 120) }, { account: creditFor(b.paidFrom), amount: -b.totalAmount, eventId: b.eventId, memo: b.paymentReference ?? undefined }],
  });
  return entry;
}

/** Stop a probable double entry (same supplier invoice number, or same supplier + amount within N days) unless the user confirms. */
async function rejectDuplicate(tx: Tx, orgId: string, livemode: boolean, doc: { supplierName: string; invoiceNumber: string | null; invoiceDate: string; currency: string; totalAmount: number }) {
  const { duplicateBillDays } = await getMonitorSettings(orgId);
  const b = schema.acctBills;
  const existing = await tx.select({ id: b.id, supplierName: b.supplierName, invoiceNumber: b.invoiceNumber, invoiceDate: b.invoiceDate, currency: b.currency, totalAmount: b.totalAmount, status: b.status, kind: b.kind })
    .from(b).where(and(eq(b.organisationId, orgId), eq(b.livemode, livemode), sql`${b.status} <> 'VOIDED'`, ilike(b.supplierName, `%${doc.supplierName.trim().slice(0, 4).replace(/[%_\\]/g, "")}%`))).limit(500);
  const hits = findDuplicateBills([{ id: "new", ...doc }, ...existing], duplicateBillDays).filter((d) => d.ids.includes("new"));
  if (!hits.length) return;
  const others = existing.filter((x) => hits.some((h) => h.ids.includes(x.id)));
  throw new AppError("conflict", `This looks like a duplicate: ${hits[0]!.detail.replace(/\(.*\)$/, "").trim()}. If it is a different document, confirm and save again.`, { duplicates: others.map((x) => ({ id: x.id, supplierName: x.supplierName, invoiceNumber: x.invoiceNumber, invoiceDate: x.invoiceDate, totalAmount: x.totalAmount, currency: x.currency, status: x.status, kind: x.kind })) });
}

export async function createBill(a: Actor, input: z.infer<typeof BillInput>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    await ensureLedgerSetup(tx, a.orgId);
    await expenseAccount(tx, a.orgId, input.accountId);
    await checkEvent(tx, a.orgId, input.eventId, input.currency);
    const { mode, paidDate, allowDuplicate, ...rest } = input;
    const expense = input.kind === "EXPENSE";
    if (!allowDuplicate) await rejectDuplicate(tx, a.orgId, isLive(mode), { supplierName: rest.supplierName, invoiceNumber: rest.invoiceNumber ?? null, invoiceDate: rest.invoiceDate, currency: rest.currency, totalAmount: rest.netAmount + rest.vatAmount });
    const [row] = await tx.insert(schema.acctBills).values({
      organisationId: a.orgId, livemode: isLive(mode), ...rest, eventId: rest.eventId ?? null, country: rest.country ?? null, dueDate: expense ? null : rest.dueDate ?? null,
      totalAmount: rest.netAmount + rest.vatAmount, paidFrom: expense ? rest.paidFrom ?? "BANK" : null, status: expense ? "PAID" : "UNPAID", paidDate: expense ? input.invoiceDate : null, createdBy: a.userId,
    }).returning();
    const entry = await postRecord(tx, a, row!, timezone);
    let [done] = await tx.update(schema.acctBills).set({ journalEntryId: entry.id }).where(eq(schema.acctBills.id, row!.id)).returning();
    // A bill that was already paid when entered: record the payment straight away.
    if (!expense && paidDate) {
      const [withPay] = await tx.update(schema.acctBills).set({ status: "PAID", paidDate, paidFrom: input.paidFrom ?? "BANK", paymentReference: input.paymentReference ?? null }).where(eq(schema.acctBills.id, row!.id)).returning();
      const pe = await postPayment(tx, a, withPay!, timezone);
      [done] = await tx.update(schema.acctBills).set({ paymentEntryId: pe.id }).where(eq(schema.acctBills.id, row!.id)).returning();
    }
    await acctAudit(tx, { ...a, action: `${input.kind === "BILL" ? "bill" : "expense_doc"}.created`, entity: "bill", entityId: row!.id, new: auditable(done!), extra: { eventId: row!.eventId, mode } });
    return done!;
  });
}

async function lockBill(tx: Tx, orgId: string, id: string) {
  const [b] = await tx.select().from(schema.acctBills).where(and(eq(schema.acctBills.id, id), eq(schema.acctBills.organisationId, orgId))).for("update");
  if (!b) throw new AppError("not_found", "Document not found");
  if (b.status === "VOIDED") throw new AppError("invalid_state", "This document has been deleted (voided).");
  return b;
}

export async function payBill(a: Actor, id: string, input: z.infer<typeof BillPay>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const b = await lockBill(tx, a.orgId, id);
    if (b.kind !== "BILL" || b.status !== "UNPAID") throw new AppError("invalid_state", "Only unpaid supplier invoices can be marked as paid.");
    const [withPay] = await tx.update(schema.acctBills).set({ status: "PAID", paidDate: input.paidDate, paidFrom: input.paidFrom, paymentReference: input.paymentReference ?? null, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctBills.id, id)).returning();
    const pe = await postPayment(tx, a, withPay!, timezone);
    const [row] = await tx.update(schema.acctBills).set({ paymentEntryId: pe.id }).where(eq(schema.acctBills.id, id)).returning();
    await acctAudit(tx, { ...a, action: "bill.paid", entity: "bill", entityId: id, old: { status: "UNPAID" }, new: { status: "PAID", paidDate: input.paidDate, paidFrom: input.paidFrom }, extra: { eventId: b.eventId } });
    return row!;
  });
}

export async function editBill(a: Actor, id: string, input: z.infer<typeof BillEdit>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const b = await lockBill(tx, a.orgId, id);
    const { reason, ...patch } = input;
    const next = { ...b, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Bill;
    next.totalAmount = next.netAmount + next.vatAmount;
    if (next.totalAmount <= 0) throw new AppError("validation_failed", "The total must be more than zero.", [{ path: "netAmount", message: "Required" }]);
    if (patch.accountId) await expenseAccount(tx, a.orgId, patch.accountId);
    if (patch.eventId !== undefined) await checkEvent(tx, a.orgId, patch.eventId, b.currency);
    if (b.kind === "BILL" && b.status === "PAID" && next.totalAmount !== b.totalAmount) throw new AppError("invalid_state", "This invoice is already paid; delete it and enter it again to change the amount.");
    const keys = ["supplierName", "supplierVat", "country", "invoiceNumber", "invoiceDate", "dueDate", "netAmount", "vatAmount", "accountId", "eventId", "description", "paidFrom"] as const;
    const changed = keys.filter((k) => (next[k] ?? null) !== (b[k] ?? null));
    if (!changed.length) return b;
    const ledgerKeys: string[] = ["supplierName", "invoiceNumber", "invoiceDate", "netAmount", "vatAmount", "accountId", "eventId", ...(b.kind === "EXPENSE" ? ["paidFrom"] : [])];
    let { journalEntryId, paymentEntryId, revision } = b;
    if (changed.some((k) => ledgerKeys.includes(k))) {
      revision = b.revision + 1;
      if (b.journalEntryId) await reverseEntry(tx, { orgId: a.orgId, entryId: b.journalEntryId, reason: `Edited: ${reason}`, userId: a.userId, timezone });
      journalEntryId = (await postRecord(tx, a, { ...next, revision }, timezone)).id;
      if (b.paymentEntryId) {
        await reverseEntry(tx, { orgId: a.orgId, entryId: b.paymentEntryId, reason: `Edited: ${reason}`, userId: a.userId, timezone });
        paymentEntryId = (await postPayment(tx, a, { ...next, revision }, timezone)).id;
      }
    }
    const { id: _id, createdAt: _c, ...values } = next;
    const [row] = await tx.update(schema.acctBills).set({ ...values, revision, journalEntryId, paymentEntryId, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctBills.id, id)).returning();
    await acctAudit(tx, { ...a, action: "bill.edited", entity: "bill", entityId: id, old: Object.fromEntries(changed.map((k) => [k, b[k]])), new: Object.fromEntries(changed.map((k) => [k, next[k]])), reason, extra: { eventId: next.eventId ?? b.eventId } });
    return row!;
  });
}

export async function voidBill(a: Actor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const b = await lockBill(tx, a.orgId, id);
    for (const e of [b.paymentEntryId, b.journalEntryId]) if (e) await reverseEntry(tx, { orgId: a.orgId, entryId: e, reason: `Deleted: ${reason}`, userId: a.userId, timezone });
    const [row] = await tx.update(schema.acctBills).set({ status: "VOIDED", voidReason: reason, voidedBy: a.userId, voidedAt: new Date(), updatedAt: new Date() }).where(eq(schema.acctBills.id, id)).returning();
    await acctAudit(tx, { ...a, action: "bill.deleted", entity: "bill", entityId: id, old: auditable(b), new: { status: "VOIDED" }, reason, extra: { eventId: b.eventId } });
    return row!;
  });
}

export const BillFilter = z.object({
  kind: z.enum(["BILL", "EXPENSE"]).optional(), status: z.enum(["UNPAID", "PAID", "VOIDED", "OVERDUE"]).optional(), accountId: z.string().uuid().optional(), eventId: z.string().uuid().optional(),
  currency: Currency.optional(), q: z.string().trim().max(120).optional(), from: IsoDate.optional(), to: IsoDate.optional(),
});
function billWhere(orgId: string, mode: Mode, f: z.infer<typeof BillFilter>): SQL | undefined {
  const b = schema.acctBills;
  const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return and(eq(b.organisationId, orgId), eq(b.livemode, isLive(mode)), f.kind ? eq(b.kind, f.kind) : undefined,
    f.status === "OVERDUE" ? and(eq(b.status, "UNPAID"), sql`${b.dueDate} < current_date`) : f.status ? eq(b.status, f.status) : undefined,
    f.accountId ? eq(b.accountId, f.accountId) : undefined, f.eventId ? eq(b.eventId, f.eventId) : undefined, f.currency ? eq(b.currency, f.currency) : undefined,
    f.from ? gte(b.invoiceDate, f.from) : undefined, f.to ? lte(b.invoiceDate, f.to) : undefined,
    f.q ? or(ilike(b.supplierName, like(f.q)), ilike(b.invoiceNumber, like(f.q)), ilike(b.description, like(f.q))) : undefined);
}

export async function listBills(orgId: string, mode: Mode, f: z.infer<typeof BillFilter>, page: { limit: number; offset: number }) {
  const b = schema.acctBills;
  const where = billWhere(orgId, mode, f);
  const [items, total, sums] = await Promise.all([
    db.select({ b, accountName: schema.acctAccounts.name, accountCode: schema.acctAccounts.code, eventName: schema.acctEvents.name, createdByName: schema.users.name }).from(b)
      .innerJoin(schema.acctAccounts, eq(schema.acctAccounts.id, b.accountId)).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, b.eventId)).leftJoin(schema.users, eq(schema.users.id, b.createdBy))
      .where(where).orderBy(desc(b.invoiceDate), desc(b.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(b).where(where),
    db.select({ currency: b.currency, net: sql<string>`sum(${b.netAmount})::text`, vat: sql<string>`sum(${b.vatAmount})::text`, total: sql<string>`sum(${b.totalAmount})::text`, unpaid: sql<string>`sum(case when ${b.status} = 'UNPAID' then ${b.totalAmount} else 0 end)::text` })
      .from(b).where(and(where, sql`${b.status} <> 'VOIDED'`)).groupBy(b.currency),
  ]);
  return {
    items: items.map((r) => ({ ...r.b, accountName: r.accountName, accountCode: r.accountCode, eventName: r.eventName, createdByName: r.createdByName, hasFile: !!r.b.fileObjectId, overdue: r.b.status === "UNPAID" && !!r.b.dueDate && r.b.dueDate < new Date().toISOString().slice(0, 10) })),
    total: total[0]?.n ?? 0,
    totals: sums.map((s) => ({ currency: s.currency, net: Number(s.net), vat: Number(s.vat), total: Number(s.total), unpaid: Number(s.unpaid) })),
  };
}

/** Recently used suppliers, for autocomplete. */
export async function suppliers(orgId: string) {
  const r = await db.execute<{ name: string; vat: string | null; country: string | null; account_id: string; currency: string }>(sql`
    select distinct on (lower(supplier_name)) supplier_name as name, supplier_vat as vat, country, account_id, currency from acct_bills
    where organisation_id = ${orgId} and status <> 'VOIDED' order by lower(supplier_name), created_at desc limit 300`);
  return r.rows.map((x) => ({ name: x.name, vat: x.vat, country: x.country, accountId: x.account_id, currency: x.currency }));
}

// ---------- files (invoice / receipt) ----------
const FILE_TYPES: Array<{ type: string; ext: string; test: (b: Buffer) => boolean }> = [
  { type: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 1024).includes(Buffer.from("%PDF-")) },
  { type: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Attach (or replace) the invoice/receipt file. The type is decided from the content, never the client name or MIME. */
export async function attachBillFile(a: Actor, id: string, bytes: Buffer, fileName: string) {
  const cap = Math.min(15, env().MAX_UPLOAD_MB) * 1024 * 1024;
  if (!bytes.length) throw new AppError("validation_failed", "The file is empty.");
  if (bytes.length > cap) throw new AppError("payload_too_large", `The file is too large. The maximum is ${Math.floor(cap / 1048576)} MB.`);
  const kind = FILE_TYPES.find((t) => t.test(bytes));
  if (!kind) throw new AppError("unsupported_media", "Upload a PDF, PNG, JPEG or WebP file.");
  await assertClean(bytes);
  const key = objectKey(a.orgId, "invoice");
  const put = await storage().put(key, bytes, kind.type);
  return db.transaction(async (tx) => {
    const b = await lockBill(tx, a.orgId, id);
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: kind.type }).returning();
    const name = `${fileName.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\.[^.]*$/, "").trim().slice(0, 80) || "invoice"}.${kind.ext}`;
    const [row] = await tx.update(schema.acctBills).set({ fileObjectId: obj!.id, fileName: name, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctBills.id, id)).returning();
    await acctAudit(tx, { ...a, action: b.fileObjectId ? "bill.file_replaced" : "bill.file_added", entity: "bill", entityId: id, new: { file: name, sha256: put.sha256, bytes: put.sizeBytes }, extra: { eventId: b.eventId } });
    return row!;
  });
}

export async function billFile(orgId: string, id: string) {
  const [r] = await db.select({ key: schema.storageObjects.key, type: schema.storageObjects.contentType, name: schema.acctBills.fileName })
    .from(schema.acctBills).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.acctBills.fileObjectId))
    .where(and(eq(schema.acctBills.id, id), eq(schema.acctBills.organisationId, orgId), eq(schema.storageObjects.organisationId, orgId)));
  if (!r) throw new AppError("not_found", "No file attached");
  return r;
}

// ---------- overview: company P&L by account, payables, VAT ----------
export async function booksOverview(orgId: string, mode: Mode, r: { from?: string | null; to?: string | null }) {
  await ensureLedgerSetup(db, orgId);
  const range = sql`${r.from ? sql` and e.entry_date >= ${r.from}::date` : sql``}${r.to ? sql` and e.entry_date <= ${r.to}::date` : sql``}`;
  const [pl, payables, vat, payroll] = await Promise.all([
    db.execute<{ currency: string; code: string; name: string; type: string; key: string | null; amount: string }>(sql`
      select e.currency, a.code, a.name, a.type, a.system_key as key, sum(case when a.type = 'REVENUE' then l.credit - l.debit else l.debit - l.credit end)::text as amount
      from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and a.type in ('REVENUE', 'EXPENSE') ${range}
      group by 1, 2, 3, 4, 5 having sum(l.debit - l.credit) <> 0 order by 1, 2`),
    db.execute<{ currency: string; unpaid: string; overdue: string; n: number; n_overdue: number }>(sql`
      select currency, sum(total_amount)::text as unpaid, sum(case when due_date < current_date then total_amount else 0 end)::text as overdue, count(*)::int as n, count(*) filter (where due_date < current_date)::int as n_overdue
      from acct_bills where organisation_id = ${orgId} and livemode = ${isLive(mode)} and status = 'UNPAID' group by 1`),
    db.execute<{ currency: string; vat: string }>(sql`
      select e.currency, sum(l.debit - l.credit)::text as vat from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and a.system_key = 'vat_input' ${range} group by 1`),
    db.execute<{ currency: string; gross: string; net: string; employer: string; n: number }>(sql`
      select currency, sum(gross_pay)::text as gross, sum(net_pay)::text as net, sum(employer_total)::text as employer, count(*)::int as n from acct_payslips
      where organisation_id = ${orgId} and livemode = ${isLive(mode)} and status in ('FINAL', 'PAID') ${r.from ? sql` and pay_date >= ${r.from}::date` : sql``} ${r.to ? sql` and pay_date <= ${r.to}::date` : sql``} group by 1`),
  ]);
  const currencies = [...new Set([...pl.rows.map((x) => x.currency), ...payables.rows.map((x) => x.currency), ...payroll.rows.map((x) => x.currency)])].sort();
  return currencies.map((currency) => {
    const lines = pl.rows.filter((x) => x.currency === currency).map((x) => ({ code: x.code, name: x.name, type: x.type, key: x.key, amount: Number(x.amount) }));
    const revenue = lines.filter((x) => x.type === "REVENUE").reduce((s, x) => s + x.amount, 0);
    const expenses = lines.filter((x) => x.type === "EXPENSE").reduce((s, x) => s + x.amount, 0);
    const p = payables.rows.find((x) => x.currency === currency), v = vat.rows.find((x) => x.currency === currency), w = payroll.rows.find((x) => x.currency === currency);
    return {
      currency, lines, revenue, expenses, netProfit: revenue - expenses,
      unpaidBills: Number(p?.unpaid ?? 0), overdueBills: Number(p?.overdue ?? 0), unpaidCount: p?.n ?? 0, overdueCount: p?.n_overdue ?? 0,
      inputVat: Number(v?.vat ?? 0), payroll: { gross: Number(w?.gross ?? 0), net: Number(w?.net ?? 0), employer: Number(w?.employer ?? 0), payslips: w?.n ?? 0 },
    };
  });
}
