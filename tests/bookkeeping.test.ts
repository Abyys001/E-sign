import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { ensureLedgerSetup } from "@/server/accounting/core";
import { booksOverview, createBill, editBill, listBills, payBill, voidBill } from "@/server/accounting/books";
import { createEmployee, createPayslip, finalisePayslip, payPayslip, payslipPdf, taxYear, updatePayslip, voidPayslip, yearToDate } from "@/server/accounting/payroll";
import { trialBalance } from "@/server/accounting/reports";
import { ctxFor, expectPg, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { await stopBoss(); });

let actor: { orgId: string; userId: string; ctx: ReturnType<typeof ctxFor> };
let acc: Record<string, string>;
const bal = async () => {
  const tb = await trialBalance(actor.orgId, "live");
  const out: Record<string, number> = {};
  for (const r of tb) { const k = Object.entries(acc).find(([, id]) => id === r.accountId)?.[0] ?? r.code; out[`${k}:${r.currency}`] = (out[`${k}:${r.currency}`] ?? 0) + r.balance; }
  return out;
};
beforeAll(async () => {
  const { org, user } = await makeOrg("Bookkeeping Test");
  actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  acc = await ensureLedgerSetup(db, org.id) as unknown as Record<string, string>;
});

describe("supplier invoices and expenses", () => {
  it("a bill is owed until paid; VAT goes to input VAT; paying clears payables", async () => {
    const b = await createBill(actor, { mode: "live", kind: "BILL", supplierName: "Venue Ltd", supplierVat: "GB123", country: "GB", invoiceNumber: "INV-9", invoiceDate: "2026-10-01", dueDate: "2026-10-31", currency: "gbp", netAmount: 100000, vatAmount: 20000, accountId: acc.rent!, eventId: null, description: null, paidFrom: null, paidDate: null, paymentReference: null });
    expect(b).toMatchObject({ status: "UNPAID", totalAmount: 120000 });
    let x = await bal();
    expect(x).toMatchObject({ "rent:gbp": 100000, "vat_input:gbp": 20000, "accounts_payable:gbp": -120000 });
    await payBill(actor, b.id, { paidDate: "2026-10-05", paidFrom: "BANK", paymentReference: "BACS-1" });
    x = await bal();
    expect(x["accounts_payable:gbp"] ?? 0).toBe(0);
    expect(x["bank:gbp"]).toBe(-120000);
    await expectPg(editBill(actor, b.id, { netAmount: 1, reason: "typo fix" }), /already paid/);
  });
  it("an expense is paid immediately; edits re-post, delete voids and reverses", async () => {
    const e = await createBill(actor, { mode: "live", kind: "EXPENSE", supplierName: "Adobe", supplierVat: null, country: "IE", invoiceNumber: null, invoiceDate: "2026-10-02", dueDate: null, currency: "eur", netAmount: 5000, vatAmount: 1150, accountId: acc.software!, eventId: null, description: "Creative Cloud", paidFrom: "CARD", paidDate: null, paymentReference: null });
    expect(e).toMatchObject({ status: "PAID", paidDate: "2026-10-02" });
    await editBill(actor, e.id, { netAmount: 6000, vatAmount: 1380, reason: "Annual price rise" });
    let x = await bal();
    expect(x).toMatchObject({ "software:eur": 6000, "vat_input:eur": 1380, "bank:eur": -7380 });
    const list = await listBills(actor.orgId, "live", {}, { limit: 50, offset: 0 });
    expect(list.totals.find((t) => t.currency === "eur")).toMatchObject({ total: 7380 });
    await voidBill(actor, e.id, "Duplicate");
    x = await bal();
    expect(x["software:eur"] ?? 0).toBe(0);
    await expectPg(db.delete(schema.acctBills).where(eq(schema.acctBills.id, e.id)), /not permitted/);
  });
  it("rejects non-expense categories", async () => {
    await expectPg(createBill(actor, { mode: "live", kind: "EXPENSE", supplierName: "x", supplierVat: null, country: null, invoiceNumber: null, invoiceDate: "2026-10-02", dueDate: null, currency: "eur", netAmount: 1, vatAmount: 0, accountId: acc.bank!, eventId: null, description: null, paidFrom: null, paidDate: null, paymentReference: null }), /expense category/);
  });
});

describe("payroll", () => {
  it("UK tax year starts on 6 April, elsewhere on 1 January", () => {
    expect(taxYear("GB", "2026-04-05")).toEqual({ start: "2025-04-06", end: "2026-04-05" });
    expect(taxYear("GB", "2026-04-06")).toEqual({ start: "2026-04-06", end: "2027-04-05" });
    expect(taxYear("DE", "2026-10-31")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });
  it("draft → finalised (numbered, booked, PDF stored) → paid; year-to-date; void reverses", async () => {
    const emp = await createEmployee(actor, { name: "Sara Ahmadi", email: null, jobTitle: "Event coordinator", employeeRef: "E001", country: "GB", currency: "gbp", taxId: "1257L", socialSecurityNo: "QQ123456C", address: null, startDate: "2026-01-01", endDate: null, payFrequency: "MONTHLY", defaultGross: 250000, active: true, notes: null, bankDetails: { accountHolder: "S Ahmadi", iban: null, bic: null, accountNumber: "12345678", sortCode: "12-34-56", bankName: null } });
    const p = await createPayslip(actor, { mode: "live", employeeId: emp.id, periodStart: "2026-09-01", periodEnd: "2026-09-30", payDate: "2026-09-30", notes: null,
      earnings: [{ label: "Basic salary", amount: 250000 }, { label: "Bonus", amount: 20000 }],
      deductions: [{ label: "Income tax", type: "TAX", amount: 33000 }, { label: "National Insurance", type: "SOCIAL", amount: 12000 }, { label: "Pension 5%", type: "PENSION", amount: 13500 }],
      employerCosts: [{ label: "Employer NI", amount: 28000 }, { label: "Employer pension 3%", amount: 8100 }] });
    expect(p).toMatchObject({ status: "DRAFT", grossPay: 270000, totalDeductions: 58500, netPay: 211500, employerTotal: 36100, number: null });
    const draftPdf = await payslipPdf(actor.orgId, p.id);
    expect(draftPdf.stored).toBe(false);
    expect(draftPdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await updatePayslip(actor, p.id, { deductions: [{ label: "Income tax", type: "TAX", amount: 33000 }, { label: "National Insurance", type: "SOCIAL", amount: 12000 }] });
    const f = await finalisePayslip(actor, p.id);
    expect(f).toMatchObject({ status: "FINAL", number: "PS-2026-0001", netPay: 225000 });
    expect(f.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await payslipPdf(actor.orgId, p.id)).stored).toBe(true);
    await expectPg(updatePayslip(actor, p.id, { notes: "x" }), /Only draft/);
    let x = await bal();
    expect(x).toMatchObject({ "wages:gbp": 270000, "employer_payroll_costs:gbp": 36100, "net_wages_payable:gbp": -225000, "payroll_liabilities:gbp": -(45000 + 36100) });
    await payPayslip(actor, p.id, { paidDate: "2026-09-30", paymentReference: "SALARY-SEP" });
    x = await bal();
    expect(x["net_wages_payable:gbp"] ?? 0).toBe(0);
    const ytd = await yearToDate(db, f, "GB");
    expect(ytd).toMatchObject({ gross: 270000, net: 225000, byType: { TAX: 33000, SOCIAL: 12000 } });
    await voidPayslip(actor, p.id, "Issued to wrong employee");
    x = await bal();
    expect(x["wages:gbp"] ?? 0).toBe(0);
    const ov = await booksOverview(actor.orgId, "live", {});
    expect(ov.find((c) => c.currency === "gbp")!.payroll.payslips).toBe(0);
    expect((await trialBalance(actor.orgId, "live")).reduce((s, r) => s + r.balance, 0)).toBe(0);
  });
});

describe("edits keep fields that were not sent", () => {
  it("editing only the amount does not clear description or invoice number", async () => {
    const b = await createBill(actor, { mode: "live", kind: "BILL", supplierName: "Printer Co", supplierVat: "GB9", country: "GB", invoiceNumber: "P-1", invoiceDate: "2026-10-02", dueDate: null, currency: "gbp", netAmount: 1000, vatAmount: 200, accountId: acc.office!, eventId: null, description: "Flyers", paidFrom: null, paidDate: null, paymentReference: null });
    const e = await editBill(actor, b.id, { netAmount: 1500, reason: "Corrected" });
    expect(e).toMatchObject({ netAmount: 1500, totalAmount: 1700, description: "Flyers", invoiceNumber: "P-1", supplierVat: "GB9" });
  });
});

describe("edit schemas never inject defaults", () => {
  it("an event-expense amount edit keeps who bears it", async () => {
    const { ExpenseEdit } = await import("@/server/accounting/expenses");
    const { BillEdit } = await import("@/server/accounting/books");
    const { PayslipEdit } = await import("@/server/accounting/payroll");
    expect(ExpenseEdit.parse({ amount: 5, reason: "abc" })).toEqual({ amount: 5, reason: "abc" });
    expect(BillEdit.parse({ netAmount: 1, reason: "abc" })).toEqual({ netAmount: 1, reason: "abc" });
    expect(PayslipEdit.parse({ payDate: "2026-01-01" })).toEqual({ payDate: "2026-01-01" });
  });
});
