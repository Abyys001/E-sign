import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { getInvoiceSettings, registrationLines } from "./invoices";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { formatMoney } from "@/lib/money";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { acctAudit, Currency, getAcctSettings, IsoDate, isLive, lockKey, ModeSchema, type Mode } from "./core";
import { postEntry, reverseEntry } from "./ledger";

/**
 * Payroll records. Pay and deductions are entered by hand (from the accountant / payroll provider); the system works out
 * net pay and year-to-date figures, issues a numbered PDF payslip and books it:
 *   finalised  Dr Wages (gross) + Dr Employer payroll costs  /  Cr Net wages payable (net) + Cr Payroll liabilities (deductions + employer costs)
 *   paid       Dr Net wages payable                          /  Cr Bank
 * Finalised payslips never change: corrections are a void (entries reversed) and a new payslip.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const Reason = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(1000);
const Country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a 2-letter country code");

// ---------- employees ----------
export const EmployeeBank = z.object({ accountHolder: opt(140), iban: opt(40), bic: opt(15), accountNumber: opt(30), sortCode: opt(12), bankName: opt(140) });
export const EmployeeInput = z.object({
  name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(200).optional().nullable().or(z.literal("").transform(() => null)),
  jobTitle: opt(120), employeeRef: opt(40), country: Country, currency: Currency, taxId: opt(60), socialSecurityNo: opt(60), address: opt(1000),
  startDate: IsoDate.optional().nullable(), endDate: IsoDate.optional().nullable(), payFrequency: z.enum(["MONTHLY", "FOUR_WEEKLY", "FORTNIGHTLY", "WEEKLY"]).default("MONTHLY"),
  defaultGross: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().nullable(), active: z.boolean().default(true), notes: opt(2000), bankDetails: EmployeeBank.optional().nullable(),
});
type EmployeeRow = typeof schema.acctEmployees.$inferSelect;
const bankHint = (b: z.infer<typeof EmployeeBank>) => { const n = (b.iban ?? b.accountNumber)?.replace(/\s/g, ""); return n ? `…${n.slice(-4)}` : b.accountHolder?.slice(0, 20) ?? null; };
export const employeeView = (e: EmployeeRow, withBank = false) => {
  const { bankDetailsEnc, ...rest } = e;
  return { ...rest, hasBankDetails: !!bankDetailsEnc, bankDetails: withBank && bankDetailsEnc ? EmployeeBank.parse(JSON.parse(decrypt(bankDetailsEnc))) : undefined };
};
const empAudit = (e: EmployeeRow) => ({ name: e.name, jobTitle: e.jobTitle, employeeRef: e.employeeRef, country: e.country, currency: e.currency, payFrequency: e.payFrequency, defaultGross: e.defaultGross, active: e.active, bankHint: e.bankHint });

export async function createEmployee(a: Actor, input: z.infer<typeof EmployeeInput>) {
  return db.transaction(async (tx) => {
    const { bankDetails, ...rest } = input;
    const bank = bankDetails ? { bankDetailsEnc: encrypt(JSON.stringify(bankDetails)), bankHint: bankHint(bankDetails) } : {};
    const [e] = await tx.insert(schema.acctEmployees).values({ organisationId: a.orgId, ...rest, email: rest.email ?? null, startDate: rest.startDate ?? null, endDate: rest.endDate ?? null, defaultGross: rest.defaultGross ?? null, createdBy: a.userId, ...bank }).returning();
    await acctAudit(tx, { ...a, action: "employee.created", entity: "employee", entityId: e!.id, new: empAudit(e!) });
    return e!;
  });
}

export async function updateEmployee(a: Actor, id: string, input: Partial<z.infer<typeof EmployeeInput>>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.acctEmployees).where(and(eq(schema.acctEmployees.id, id), eq(schema.acctEmployees.organisationId, a.orgId))).for("update");
    if (!before) throw new AppError("not_found", "Employee not found");
    const { bankDetails, ...rest } = input;
    const bank = bankDetails === undefined ? {} : bankDetails === null ? { bankDetailsEnc: null, bankHint: null } : { bankDetailsEnc: encrypt(JSON.stringify(bankDetails)), bankHint: bankHint(bankDetails) };
    const [e] = await tx.update(schema.acctEmployees).set({ ...rest, ...bank, updatedAt: new Date() }).where(eq(schema.acctEmployees.id, id)).returning();
    await acctAudit(tx, { ...a, action: "employee.updated", entity: "employee", entityId: id, old: empAudit(before), new: empAudit(e!), extra: bankDetails !== undefined ? { bankDetailsChanged: true } : undefined });
    return e!;
  });
}

export async function listEmployees(orgId: string, livemode: boolean) {
  const rows = await db.select({ e: schema.acctEmployees, ytdGross: sql<string>`(select coalesce(sum(p.gross_pay), 0)::text from acct_payslips p where p.employee_id = "acct_employees"."id" and p.livemode = ${livemode} and p.status in ('FINAL','PAID') and p.pay_date >= date_trunc('year', current_date))`, lastPay: sql<string | null>`(select max(p.pay_date)::text from acct_payslips p where p.employee_id = "acct_employees"."id" and p.livemode = ${livemode} and p.status in ('FINAL','PAID'))` })
    .from(schema.acctEmployees).where(eq(schema.acctEmployees.organisationId, orgId)).orderBy(desc(schema.acctEmployees.active), asc(schema.acctEmployees.name));
  return rows.map((r) => ({ ...employeeView(r.e), ytdGross: Number(r.ytdGross), lastPayDate: r.lastPay }));
}

// ---------- payslips ----------
const Line = z.object({ label: z.string().trim().min(1).max(80), amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
export const DEDUCTION_TYPES = ["TAX", "SOCIAL", "PENSION", "STUDENT_LOAN", "OTHER"] as const;
const Deduction = Line.extend({ type: z.enum(DEDUCTION_TYPES).default("OTHER") });
export const PayslipInput = z.object({
  mode: ModeSchema, employeeId: z.string().uuid(), periodStart: IsoDate, periodEnd: IsoDate, payDate: IsoDate,
  earnings: z.array(Line).min(1).max(30), deductions: z.array(Deduction).max(30).default([]), employerCosts: z.array(Line).max(20).default([]), notes: opt(2000),
}).refine((p) => p.periodStart <= p.periodEnd, { message: "The period must start before it ends", path: ["periodEnd"] });
export const PayslipEdit = z.object({
  periodStart: IsoDate.optional(), periodEnd: IsoDate.optional(), payDate: IsoDate.optional(),
  earnings: z.array(Line).min(1).max(30).optional(), deductions: z.array(Deduction).max(30).optional(), employerCosts: z.array(Line).max(20).optional(), notes: opt(2000).optional(),
});

const sum = (l: Array<{ amount: number }>) => l.reduce((s, x) => s + x.amount, 0);
function totals(p: { earnings: Array<{ amount: number }>; deductions: Array<{ amount: number }>; employerCosts: Array<{ amount: number }> }) {
  const grossPay = sum(p.earnings), totalDeductions = sum(p.deductions);
  if (totalDeductions > grossPay) throw new AppError("validation_failed", "Deductions are larger than gross pay.", [{ path: "deductions", message: "Too large" }]);
  return { grossPay, totalDeductions, netPay: grossPay - totalDeductions, employerTotal: sum(p.employerCosts) };
}

async function employeeFor(tx: Tx | typeof db, orgId: string, id: string) {
  const [e] = await tx.select().from(schema.acctEmployees).where(and(eq(schema.acctEmployees.id, id), eq(schema.acctEmployees.organisationId, orgId)));
  if (!e) throw new AppError("validation_failed", "Employee not found.", [{ path: "employeeId", message: "Choose an employee." }]);
  return e;
}

export async function createPayslip(a: Actor, input: z.infer<typeof PayslipInput>) {
  return db.transaction(async (tx) => {
    const e = await employeeFor(tx, a.orgId, input.employeeId);
    const { mode, ...rest } = input;
    const [p] = await tx.insert(schema.acctPayslips).values({ organisationId: a.orgId, livemode: isLive(mode), ...rest, notes: rest.notes ?? null, currency: e.currency, ...totals(rest), createdBy: a.userId }).returning();
    await acctAudit(tx, { ...a, action: "payslip.drafted", entity: "payslip", entityId: p!.id, new: { employee: e.name, period: `${p!.periodStart}–${p!.periodEnd}`, gross: p!.grossPay, net: p!.netPay } });
    return p!;
  });
}

async function lockPayslip(tx: Tx, orgId: string, id: string) {
  const [p] = await tx.select().from(schema.acctPayslips).where(and(eq(schema.acctPayslips.id, id), eq(schema.acctPayslips.organisationId, orgId))).for("update");
  if (!p) throw new AppError("not_found", "Payslip not found");
  return p;
}

export async function updatePayslip(a: Actor, id: string, input: z.infer<typeof PayslipEdit>) {
  return db.transaction(async (tx) => {
    const p = await lockPayslip(tx, a.orgId, id);
    if (p.status !== "DRAFT") throw new AppError("invalid_state", "Only draft payslips can be changed. Void a finalised payslip and issue a new one.");
    const next = { ...p, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as typeof p;
    if (next.periodStart > next.periodEnd) throw new AppError("validation_failed", "The period must start before it ends.", [{ path: "periodEnd", message: "Invalid" }]);
    const t = totals(next as never);
    const [row] = await tx.update(schema.acctPayslips).set({ periodStart: next.periodStart, periodEnd: next.periodEnd, payDate: next.payDate, earnings: next.earnings, deductions: next.deductions, employerCosts: next.employerCosts, notes: next.notes, ...t, updatedAt: new Date() }).where(eq(schema.acctPayslips.id, id)).returning();
    await acctAudit(tx, { ...a, action: "payslip.updated", entity: "payslip", entityId: id, old: { gross: p.grossPay, net: p.netPay }, new: { gross: t.grossPay, net: t.netPay } });
    return row!;
  });
}

/** Tax year containing `date`: 6 April for the UK, calendar year elsewhere. */
export function taxYear(country: string, date: string): { start: string; end: string } {
  const y = Number(date.slice(0, 4));
  if (country === "GB") { const s = date >= `${y}-04-06` ? y : y - 1; return { start: `${s}-04-06`, end: `${s + 1}-04-05` }; }
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/** Year-to-date totals for the employee up to and including this payslip (finalised payslips only). */
export async function yearToDate(tx: Tx | typeof db, p: { employeeId: string; livemode: boolean; payDate: string; id: string }, country: string) {
  const ty = taxYear(country, p.payDate);
  const rows = await tx.select().from(schema.acctPayslips).where(and(eq(schema.acctPayslips.employeeId, p.employeeId), eq(schema.acctPayslips.livemode, p.livemode), inArray(schema.acctPayslips.status, ["FINAL", "PAID"]), gte(schema.acctPayslips.payDate, ty.start), lte(schema.acctPayslips.payDate, p.payDate)));
  const all = rows;
  const byType: Record<string, number> = {};
  for (const r of all) for (const d of r.deductions as Array<{ type: string; amount: number }>) byType[d.type] = (byType[d.type] ?? 0) + d.amount;
  return { taxYear: ty, gross: sum(all.map((r) => ({ amount: r.grossPay }))), deductions: sum(all.map((r) => ({ amount: r.totalDeductions }))), net: sum(all.map((r) => ({ amount: r.netPay }))), employer: sum(all.map((r) => ({ amount: r.employerTotal }))), byType };
}

export async function finalisePayslip(a: Actor, id: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const p = await lockPayslip(tx, a.orgId, id);
    if (p.status !== "DRAFT") throw new AppError("invalid_state", "This payslip is already finalised.");
    const e = await employeeFor(tx, a.orgId, p.employeeId);
    // Sequential number per organisation and pay year: PS-2026-0001.
    const year = p.payDate.slice(0, 4);
    await lockKey(tx, `payslip-number:${a.orgId}:${year}`);
    const [last] = await tx.select({ n: sql<number>`coalesce(max(substring(${schema.acctPayslips.number} from '\\d+$')::int), 0)` }).from(schema.acctPayslips).where(and(eq(schema.acctPayslips.organisationId, a.orgId), sql`${schema.acctPayslips.number} like ${`PS-${year}-%`}`));
    const number = `PS-${year}-${String((last?.n ?? 0) + 1).padStart(4, "0")}`;
    const memo = `Payroll ${e.name} ${p.periodStart}–${p.periodEnd}`;
    const { entry } = await postEntry(tx, {
      orgId: a.orgId, livemode: p.livemode, entryType: "PAYROLL", sourceDate: new Date(`${p.payDate}T12:00:00Z`), entryDate: p.payDate, currency: p.currency,
      description: `Payslip ${number} — ${e.name} (${p.periodStart} to ${p.periodEnd})`, reference: number, sourceType: "payslip", sourceId: p.id, idempotencyKey: `payslip:${p.id}`, createdBy: a.userId, timezone,
      postings: [
        { account: "wages", amount: p.grossPay, memo }, { account: "employer_payroll_costs", amount: p.employerTotal, memo },
        { account: "net_wages_payable", amount: -p.netPay, memo }, { account: "payroll_liabilities", amount: -(p.totalDeductions + p.employerTotal), memo },
      ],
    });
    const [withNo] = await tx.update(schema.acctPayslips).set({ number, status: "FINAL", journalEntryId: entry.id, finalisedBy: a.userId, finalisedAt: new Date(), updatedAt: new Date() }).where(eq(schema.acctPayslips.id, id)).returning();
    // The issued PDF is stored once and never regenerated, so what the employee received is what stays on file.
    const ytd = await yearToDate(tx, withNo!, e.country);
    const org = await orgInfo(tx, a.orgId);
    const pdf = await renderPayslipPdf({ p: withNo!, e, ytd, org });
    const key = objectKey(a.orgId, "payslip");
    const put = await storage().put(key, pdf, "application/pdf");
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: "application/pdf" }).returning();
    const [row] = await tx.update(schema.acctPayslips).set({ pdfObjectId: obj!.id, pdfSha256: put.sha256 }).where(eq(schema.acctPayslips.id, id)).returning();
    await acctAudit(tx, { ...a, action: "payslip.finalised", entity: "payslip", entityId: id, new: { number, employee: e.name, gross: p.grossPay, deductions: p.totalDeductions, net: p.netPay, employer: p.employerTotal, currency: p.currency, pdfSha256: put.sha256 } });
    return row!;
  });
}

export const PayslipPay = z.object({ paidDate: IsoDate, paymentReference: opt(120) });
export async function payPayslip(a: Actor, id: string, input: z.infer<typeof PayslipPay>) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const p = await lockPayslip(tx, a.orgId, id);
    if (p.status !== "FINAL") throw new AppError("invalid_state", "Only finalised, unpaid payslips can be marked as paid.");
    const { entry } = await postEntry(tx, {
      orgId: a.orgId, livemode: p.livemode, entryType: "PAYROLL_PAYMENT", sourceDate: new Date(`${input.paidDate}T12:00:00Z`), entryDate: input.paidDate, currency: p.currency,
      description: `Net pay for payslip ${p.number}`, reference: input.paymentReference ?? p.number, sourceType: "payslip_payment", sourceId: p.id, idempotencyKey: `payslippay:${p.id}`, createdBy: a.userId, timezone,
      postings: [{ account: "net_wages_payable", amount: p.netPay, memo: p.number ?? undefined }, { account: "bank", amount: -p.netPay, memo: input.paymentReference ?? undefined }],
    });
    const [row] = await tx.update(schema.acctPayslips).set({ status: "PAID", paidDate: input.paidDate, paymentReference: input.paymentReference ?? null, paymentEntryId: entry.id, updatedAt: new Date() }).where(eq(schema.acctPayslips.id, id)).returning();
    await acctAudit(tx, { ...a, action: "payslip.paid", entity: "payslip", entityId: id, new: { number: p.number, paidDate: input.paidDate, net: p.netPay } });
    return row!;
  });
}

export async function voidPayslip(a: Actor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const p = await lockPayslip(tx, a.orgId, id);
    if (p.status === "VOIDED") throw new AppError("invalid_state", "This payslip is already void.");
    for (const e of [p.paymentEntryId, p.journalEntryId]) if (e) await reverseEntry(tx, { orgId: a.orgId, entryId: e, reason: `Payslip voided: ${reason}`, userId: a.userId, timezone });
    const [row] = await tx.update(schema.acctPayslips).set({ status: "VOIDED", voidReason: reason, voidedBy: a.userId, voidedAt: new Date(), updatedAt: new Date() }).where(eq(schema.acctPayslips.id, id)).returning();
    await acctAudit(tx, { ...a, action: "payslip.voided", entity: "payslip", entityId: id, old: { status: p.status, number: p.number }, new: { status: "VOIDED" }, reason });
    return row!;
  });
}
export { Reason as PayrollReason };

export async function listPayslips(orgId: string, mode: Mode, f: { employeeId?: string; status?: string; from?: string; to?: string }) {
  const p = schema.acctPayslips;
  const rows = await db.select({ p, employeeName: schema.acctEmployees.name, employeeRef: schema.acctEmployees.employeeRef, country: schema.acctEmployees.country }).from(p).innerJoin(schema.acctEmployees, eq(schema.acctEmployees.id, p.employeeId))
    .where(and(eq(p.organisationId, orgId), eq(p.livemode, isLive(mode)), f.employeeId ? eq(p.employeeId, f.employeeId) : undefined, f.status ? eq(p.status, f.status) : undefined, f.from ? gte(p.payDate, f.from) : undefined, f.to ? lte(p.payDate, f.to) : undefined))
    .orderBy(desc(p.payDate), desc(p.createdAt)).limit(500);
  return rows.map((r) => ({ ...r.p, employeeName: r.employeeName, employeeRef: r.employeeRef, country: r.country, hasPdf: !!r.p.pdfObjectId }));
}

export async function payslipPdf(orgId: string, id: string): Promise<{ bytes: Buffer; name: string; stored: boolean }> {
  const [r] = await db.select({ p: schema.acctPayslips, e: schema.acctEmployees }).from(schema.acctPayslips).innerJoin(schema.acctEmployees, eq(schema.acctEmployees.id, schema.acctPayslips.employeeId))
    .where(and(eq(schema.acctPayslips.id, id), eq(schema.acctPayslips.organisationId, orgId)));
  if (!r) throw new AppError("not_found", "Payslip not found");
  const name = `${r.p.number ?? "payslip-draft"}-${r.e.name.normalize("NFKD").replace(/[^\w]+/g, "-").slice(0, 40)}.pdf`;
  if (r.p.pdfObjectId) {
    const [o] = await db.select().from(schema.storageObjects).where(and(eq(schema.storageObjects.id, r.p.pdfObjectId), eq(schema.storageObjects.organisationId, orgId)));
    if (o) return { bytes: await storage().getBuffer(o.key), name, stored: true };
  }
  // Drafts are previewed on the fly (watermarked), never stored.
  return { bytes: await renderPayslipPdf({ p: r.p, e: r.e, ytd: await yearToDate(db, r.p, r.e.country), org: await orgInfo(db, orgId) }), name, stored: false };
}

async function orgInfo(tx: Tx | typeof db, orgId: string) {
  const [o] = await tx.select({ name: schema.organisations.name }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  const s = await getInvoiceSettings(orgId);
  return { name: s.legalName ?? o?.name ?? "", lines: [s.address?.replace(/\n+/g, ", "), registrationLines(s).join(" · ")].filter((x): x is string => !!x) };
}

// ---------- PDF ----------
type Ytd = Awaited<ReturnType<typeof yearToDate>>;
const DED_LABEL: Record<string, Record<string, string>> = {
  GB: { TAX: "Income tax (PAYE)", SOCIAL: "National Insurance", PENSION: "Pension", STUDENT_LOAN: "Student loan", OTHER: "Other" },
  DE: { TAX: "Lohnsteuer", SOCIAL: "Sozialversicherung", PENSION: "Rentenversicherung", STUDENT_LOAN: "Darlehen", OTHER: "Sonstiges" },
  _: { TAX: "Income tax", SOCIAL: "Social security", PENSION: "Pension", STUDENT_LOAN: "Loan repayment", OTHER: "Other" },
};
const ID_LABEL: Record<string, [string, string]> = { GB: ["Tax code", "NI number"], DE: ["Steuer-ID", "SV-Nummer"], _: ["Tax ID", "Social security no."] };

export async function renderPayslipPdf(d: { p: typeof schema.acctPayslips.$inferSelect; e: EmployeeRow; ytd: Ytd; org: { name: string; lines?: string[] } }): Promise<Buffer> {
  const f = load();
  const M = 48;
  const doc = new PDFDocument({ size: "A4", margin: M, info: { Title: `Payslip ${d.p.number ?? "DRAFT"}`, Author: d.org.name, Subject: `${d.e.name} ${d.p.periodStart}–${d.p.periodEnd}` } });
  doc.registerFont("reg", f.reg); doc.registerFont("bold", f.bold); doc.registerFont("fa", f.faReg); doc.registerFont("faBold", f.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - M * 2;
  const m = (v: number) => formatMoney(v, d.p.currency, "en");
  const font = (s: string, bold = false) => doc.font(hasRtl(s) ? (bold ? "faBold" : "fa") : bold ? "bold" : "reg");
  const at = (s: string, x: number, y: number, o: { bold?: boolean; size?: number; color?: string; width?: number; align?: "left" | "right" | "center" } = {}) => {
    font(s, o.bold).fontSize(o.size ?? 9.5).fillColor(o.color ?? C.text).text(rtl(s), x, y, { width: o.width, align: o.align ?? "left", lineBreak: !!o.width });
  };
  const dl = DED_LABEL[d.e.country] ?? DED_LABEL._!;
  const il = ID_LABEL[d.e.country] ?? ID_LABEL._!;

  // Header
  at(d.org.name || "Payslip", M, M, { bold: true, size: 16 });
  at("PAYSLIP", M, M + 2, { bold: true, size: 11, color: C.primary, width: W, align: "right" });
  at(d.p.number ?? "DRAFT — not issued", M, M + 18, { size: 9, color: C.muted, width: W, align: "right" });
  const extra = d.org.lines ?? [];
  extra.forEach((l, i) => at(l, M, M + 20 + i * 10, { size: 7.5, color: C.muted, width: W - 160 }));
  const top = M + Math.max(40, 24 + extra.length * 10);
  doc.moveTo(M, top).lineTo(M + W, top).lineWidth(1).strokeColor(C.rule).stroke();

  // Employee / period block
  let y = top + 14;
  const col = W / 2;
  const kv = (k: string, v: string | null | undefined, x: number, yy: number) => { at(k, x, yy, { size: 8, color: C.muted }); at(v || "—", x, yy + 10, { bold: true, size: 10, width: col - 12 }); };
  kv("Employee", d.e.name, M, y); kv("Pay period", `${d.p.periodStart} to ${d.p.periodEnd}`, M + col, y); y += 32;
  kv("Employee ref.", d.e.employeeRef, M, y); kv("Pay date", d.p.payDate, M + col, y); y += 32;
  kv(il[0], d.e.taxId, M, y); kv(il[1], d.e.socialSecurityNo, M + col, y); y += 32;
  kv("Job title", d.e.jobTitle, M, y); kv("Currency", d.p.currency.toUpperCase(), M + col, y); y += 40;

  // Earnings | Deductions tables
  const table = (title: string, rows: Array<[string, number]>, x: number, total: [string, number]) => {
    let yy = y;
    doc.rect(x, yy, col - 12, 20).fill(C.tint);
    at(title, x + 8, yy + 6, { bold: true, size: 9 }); at("Amount", x + 8, yy + 6, { bold: true, size: 9, width: col - 28, align: "right" });
    yy += 26;
    for (const [l, v] of rows) { at(l, x + 8, yy, { size: 9.5, width: col - 120 }); at(m(v), x + 8, yy, { size: 9.5, width: col - 28, align: "right" }); yy += 16; }
    doc.moveTo(x, yy + 2).lineTo(x + col - 12, yy + 2).lineWidth(0.6).strokeColor(C.rule).stroke();
    at(total[0], x + 8, yy + 8, { bold: true, size: 10 }); at(m(total[1]), x + 8, yy + 8, { bold: true, size: 10, width: col - 28, align: "right" });
    return yy + 28;
  };
  const earnings = (d.p.earnings as Array<{ label: string; amount: number }>).map((x) => [x.label, x.amount] as [string, number]);
  const deductions = (d.p.deductions as Array<{ label: string; type: string; amount: number }>).map((x) => [x.label || dl[x.type] || x.type, x.amount] as [string, number]);
  const yE = table("Earnings", earnings, M, ["Gross pay", d.p.grossPay]);
  const yD = table("Deductions", deductions.length ? deductions : [["None", 0]], M + col, ["Total deductions", d.p.totalDeductions]);
  y = Math.max(yE, yD) + 8;

  // Net pay
  doc.roundedRect(M, y, W, 46, 6).fill(C.primary);
  at("NET PAY", M + 14, y + 18, { bold: true, size: 11, color: C.white });
  at(m(d.p.netPay), M + 14, y + 12, { bold: true, size: 20, color: C.white, width: W - 28, align: "right" });
  y += 64;

  // Year to date
  at(`Year to date (${d.ytd.taxYear.start} to ${d.ytd.taxYear.end})`, M, y, { bold: true, size: 10 }); y += 16;
  const ytdCells: Array<[string, number]> = [["Gross pay", d.ytd.gross], [dl.TAX!, d.ytd.byType.TAX ?? 0], [dl.SOCIAL!, d.ytd.byType.SOCIAL ?? 0], [dl.PENSION!, d.ytd.byType.PENSION ?? 0], ["Net pay", d.ytd.net]];
  const cw = W / ytdCells.length;
  ytdCells.forEach(([l, v], i) => { at(l, M + i * cw, y, { size: 8, color: C.muted, width: cw - 6 }); at(m(v), M + i * cw, y + 12, { bold: true, size: 10, width: cw - 6 }); });
  y += 40;

  const er = d.p.employerCosts as Array<{ label: string; amount: number }>;
  if (er.length) {
    at("Employer contributions (not deducted from your pay)", M, y, { bold: true, size: 9, color: C.muted }); y += 14;
    for (const x of er) { at(x.label, M, y, { size: 9, color: C.muted, width: W - 120 }); at(m(x.amount), M, y, { size: 9, color: C.muted, width: W, align: "right" }); y += 14; }
    y += 6;
  }
  if (d.p.notes) { at(d.p.notes, M, y, { size: 9, color: C.muted, width: W }); y = doc.y + 8; }
  if (d.p.status === "DRAFT") { doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }); at("DRAFT", 0, doc.page.height / 2 - 40, { bold: true, size: 90, color: "#e5e5ea", width: doc.page.width, align: "center" }); doc.restore(); }
  at(`${d.org.name} · ${d.p.number ?? "Draft"} · Generated ${new Date().toISOString().slice(0, 10)}`, M, doc.page.height - M - 10, { size: 7.5, color: C.muted, width: W, align: "center" });
  doc.end();
  return done;
}
