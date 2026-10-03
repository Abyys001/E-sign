import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import PDFDocument from "pdfkit";
import { db } from "@/db";
import { feeIncluded, formatMoney, toDecimalString } from "@/lib/money";
import { C, load } from "../signing/certificate";
import { booksOverview } from "./books";
import { getAcctSettings, isLive, type Mode } from "./core";
import { eventFinancials, totalsByCurrency } from "./finance";
import { getInvoiceSettings, registrationLines } from "./invoices";
import { csvValue, trialBalance } from "./reports";

/**
 * Accountant pack: everything an external accountant needs for a period, from the ledger and the source records —
 * a PDF report plus one CSV per area, zipped. Also the data-quality checks (gaps, unreconciled items, missing receipts…)
 * used by the report and by the AI review.
 */
export type Range = { from: string; to: string };
const n = (v: unknown) => Number(v ?? 0);
const q = <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => db.execute<T>(s).then((r) => r.rows);

// ---------- data-quality checks ----------
export type Check = { severity: "high" | "medium" | "low"; code: string; title: string; detail: string; count: number; amounts?: Record<string, number> };

export async function bookkeepingChecks(orgId: string, mode: Mode, r: Range): Promise<Check[]> {
  const live = isLive(mode);
  const [unmatched, unrec, noReceipt, overdue, noOrganiser, unpaidPayslips, payrollLiab, unclassified, unallocated, failedRefunds, disputes, negOrg, noInvoiceVat, stalePending] = await Promise.all([
    q<{ currency: string; n: number; amount: string }>(sql`select currency, count(*)::int n, sum(amount)::text amount from stripe_balance_transactions where organisation_id = ${orgId} and livemode = ${live} and kind = 'SALE' and match_status = 'UNMATCHED' group by 1`),
    q<{ n: number }>(sql`select count(*)::int n from stripe_balance_transactions where organisation_id = ${orgId} and livemode = ${live} and reconciliation_status in ('UNMATCHED','PARTIAL','DUPLICATE','MANUAL_REVIEW','ERROR')`),
    q<{ currency: string; n: number; amount: string }>(sql`select currency, count(*)::int n, sum(total_amount)::text amount from acct_bills where organisation_id = ${orgId} and livemode = ${live} and status <> 'VOIDED' and file_object_id is null and invoice_date between ${r.from}::date and ${r.to}::date group by 1`),
    q<{ currency: string; n: number; amount: string }>(sql`select currency, count(*)::int n, sum(total_amount)::text amount from acct_bills where organisation_id = ${orgId} and livemode = ${live} and status = 'UNPAID' and due_date < current_date group by 1`),
    q<{ n: number }>(sql`select count(*)::int n from acct_events where organisation_id = ${orgId} and organiser_id is null`),
    q<{ currency: string; n: number; amount: string }>(sql`select currency, count(*)::int n, sum(net_pay)::text amount from acct_payslips where organisation_id = ${orgId} and livemode = ${live} and status = 'FINAL' and pay_date < current_date group by 1`),
    q<{ currency: string; amount: string }>(sql`select e.currency, sum(l.credit - l.debit)::text amount from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id where e.organisation_id = ${orgId} and e.livemode = ${live} and a.system_key = 'payroll_liabilities' and e.entry_date <= ${r.to}::date group by 1 having sum(l.credit - l.debit) <> 0`),
    q<{ currency: string; amount: string }>(sql`select e.currency, sum(l.credit - l.debit)::text amount from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id where e.organisation_id = ${orgId} and e.livemode = ${live} and a.system_key = 'unclassified' group by 1 having sum(l.credit - l.debit) <> 0`),
    q<{ currency: string; amount: string }>(sql`select e.currency, sum(l.credit - l.debit)::text amount from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id where e.organisation_id = ${orgId} and e.livemode = ${live} and a.system_key = 'unallocated_receipts' group by 1 having sum(l.credit - l.debit) <> 0`),
    q<{ n: number }>(sql`select count(*)::int n from stripe_refunds where organisation_id = ${orgId} and livemode = ${live} and status in ('failed','canceled','requires_action')`),
    q<{ n: number }>(sql`select count(*)::int n from stripe_disputes where organisation_id = ${orgId} and livemode = ${live} and status not in ('won','lost','warning_closed')`),
    q<{ name: string; currency: string; amount: string }>(sql`select o.name, e.currency, sum(l.credit - l.debit)::text amount from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id join acct_organisers o on o.id = l.organiser_id where e.organisation_id = ${orgId} and e.livemode = ${live} and a.system_key = 'organiser_payable' group by 1, 2 having sum(l.credit - l.debit) < 0`),
    q<{ n: number }>(sql`select count(*)::int n from acct_bills where organisation_id = ${orgId} and livemode = ${live} and status <> 'VOIDED' and vat_amount > 0 and supplier_vat is null and invoice_date between ${r.from}::date and ${r.to}::date`),
    q<{ n: number }>(sql`select count(*)::int n from acct_organiser_payments where organisation_id = ${orgId} and livemode = ${live} and status = 'PENDING' and payment_date < current_date - 7`),
  ]);
  const amt = (rows: Array<{ currency: string; amount: string }>) => Object.fromEntries(rows.map((x) => [x.currency, n(x.amount)]));
  const cnt = (rows: Array<{ n: number }>) => rows.reduce((s, x) => s + x.n, 0);
  const out: Check[] = [];
  const add = (c: Check) => { if (c.count > 0 || Object.keys(c.amounts ?? {}).length) out.push(c); };
  add({ severity: "high", code: "UNMATCHED_SALES", title: "Ticket sales not assigned to an event", detail: "Money received in Stripe that is not linked to an event/organiser, so it is in Unallocated Receipts and nobody is paid for it. Create the missing events or assign the sales.", count: cnt(unmatched), amounts: amt(unmatched) });
  add({ severity: "medium", code: "UNRECONCILED", title: "Stripe transactions needing review", detail: "Transactions under Reconciliation (unmatched, partial, duplicate or manual review).", count: cnt(unrec) });
  add({ severity: "high", code: "SUSPENSE", title: "Unclassified Stripe activity (suspense account)", detail: "Stripe activity booked to suspense; classify it to the right account.", count: unclassified.length, amounts: amt(unclassified) });
  add({ severity: "medium", code: "UNALLOCATED", title: "Balance on Unallocated Stripe Receipts", detail: "Should be zero once every receipt is allocated (fully refunded unknown events net to zero).", count: unallocated.length, amounts: amt(unallocated) });
  add({ severity: "medium", code: "MISSING_RECEIPTS", title: "Invoices/expenses without an uploaded document", detail: "Costs without a supplier invoice or receipt attached; an accountant (and the tax authority) will ask for these.", count: cnt(noReceipt), amounts: amt(noReceipt) });
  add({ severity: "medium", code: "VAT_NO_SUPPLIER_NUMBER", title: "VAT claimed without the supplier's VAT number", detail: "Input VAT is only reclaimable with a valid VAT invoice; record the supplier VAT number.", count: cnt(noInvoiceVat) });
  add({ severity: "medium", code: "OVERDUE_BILLS", title: "Overdue supplier invoices", detail: "Unpaid supplier invoices past their due date.", count: cnt(overdue), amounts: amt(overdue) });
  add({ severity: "medium", code: "UNPAID_PAYSLIPS", title: "Issued payslips not marked as paid", detail: "Net pay due before today that has not been recorded as paid.", count: cnt(unpaidPayslips), amounts: amt(unpaidPayslips) });
  add({ severity: "low", code: "PAYROLL_LIABILITIES", title: "Payroll taxes & deductions still owed", detail: "Balance on Payroll Liabilities (tax, NI/social, pension) to pay to the authorities/pension provider; record those payments as expenses or adjustments.", count: payrollLiab.length, amounts: amt(payrollLiab) });
  add({ severity: "high", code: "ORGANISER_OVERPAID", title: "Organisers who owe Bilit money", detail: `Negative balances (overpaid or booking fees to recover): ${negOrg.map((x) => `${x.name} ${formatMoney(-n(x.amount), x.currency)}`).join(", ")}`, count: negOrg.length });
  add({ severity: "low", code: "NO_ORGANISER", title: "Events without an organiser", detail: "Sales for these events cannot be matched.", count: cnt(noOrganiser) });
  add({ severity: "medium", code: "FAILED_REFUNDS", title: "Failed or stuck refunds", detail: "Refunds Stripe could not complete.", count: cnt(failedRefunds) });
  add({ severity: "medium", code: "OPEN_DISPUTES", title: "Open chargebacks", detail: "Disputes still open in Stripe.", count: cnt(disputes) });
  add({ severity: "low", code: "STALE_PENDING_PAYMENTS", title: "Organiser payments pending for over a week", detail: "Either pay them or void them.", count: cnt(stalePending) });
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------- collected data ----------
export async function accountantData(orgId: string, mode: Mode, r: Range) {
  const live = isLive(mode);
  const [settings, inv, books, events, tb, checks, payments, expenses, bills, payslips, refunds, payouts, custInv, ledger, outputVat] = await Promise.all([
    getAcctSettings(orgId), getInvoiceSettings(orgId), booksOverview(orgId, mode, r), eventFinancials(orgId, mode, r), trialBalance(orgId, mode, r.to), bookkeepingChecks(orgId, mode, r),
    q<Record<string, unknown>>(sql`select p.payment_date, o.name organiser, e.name event, e.code event_code, p.amount, p.currency, p.method, p.bank_reference, p.status, p.notes, p.void_reason from acct_organiser_payments p join acct_organisers o on o.id = p.organiser_id left join acct_events e on e.id = p.event_id where p.organisation_id = ${orgId} and p.livemode = ${live} and p.payment_date between ${r.from}::date and ${r.to}::date order by p.payment_date`),
    q<Record<string, unknown>>(sql`select x.expense_date, e.name event, e.code event_code, x.name, x.category, x.amount, x.currency, x.borne_by, x.status, x.receipt_object_id is not null has_receipt, x.description from acct_event_expenses x join acct_events e on e.id = x.event_id where x.organisation_id = ${orgId} and x.livemode = ${live} and x.expense_date between ${r.from}::date and ${r.to}::date order by x.expense_date`),
    q<Record<string, unknown>>(sql`select b.kind, b.invoice_date, b.supplier_name, b.supplier_vat, b.country, b.invoice_number, a.code account_code, a.name account, e.name event, b.net_amount, b.vat_amount, b.total_amount, b.currency, b.status, b.due_date, b.paid_date, b.paid_from, b.file_object_id is not null has_document, b.description from acct_bills b join acct_accounts a on a.id = b.account_id left join acct_events e on e.id = b.event_id where b.organisation_id = ${orgId} and b.livemode = ${live} and b.invoice_date between ${r.from}::date and ${r.to}::date order by b.invoice_date`),
    q<Record<string, unknown>>(sql`select p.number, p.pay_date, p.period_start, p.period_end, m.name employee, m.employee_ref, m.country, p.gross_pay, p.total_deductions, p.net_pay, p.employer_total, p.currency, p.status, p.paid_date from acct_payslips p join acct_employees m on m.id = p.employee_id where p.organisation_id = ${orgId} and p.livemode = ${live} and p.pay_date between ${r.from}::date and ${r.to}::date and p.status <> 'DRAFT' order by p.pay_date`),
    q<Record<string, unknown>>(sql`select r.stripe_created_at, r.refund_id, r.charge_id, ev.name event, -bt.amount amount, r.currency, r.status, r.reason, r.keep_booking_fee, r.note, bt.commission_amount commission_reversed from stripe_refunds r left join stripe_balance_transactions bt on bt.stripe_account_ref = r.stripe_account_ref and bt.source_id = r.refund_id and bt.kind = 'REFUND' left join acct_events ev on ev.id = bt.event_id where r.organisation_id = ${orgId} and r.livemode = ${live} and r.stripe_created_at::date between ${r.from}::date and ${r.to}::date order by r.stripe_created_at`),
    q<Record<string, unknown>>(sql`select payout_id, stripe_created_at, arrival_date, amount, currency, status, included_count, reconciliation_status from stripe_payouts where organisation_id = ${orgId} and livemode = ${live} and stripe_created_at::date between ${r.from}::date and ${r.to}::date order by stripe_created_at`),
    q<Record<string, unknown>>(sql`select number, kind, vat_invoice, issue_date, customer->>'name' customer, customer->>'company' company, customer->>'vatNumber' customer_vat, net_total, vat_total, gross_total, currency, status from acct_customer_invoices where organisation_id = ${orgId} and livemode = ${live} and issue_date between ${r.from}::date and ${r.to}::date order by number`),
    q<Record<string, unknown>>(sql`select e.seq, e.entry_date, e.entry_type, e.description, e.reference, e.currency, a.code account_code, a.name account, l.debit, l.credit, ev.code event_code, o.name organiser, e.status from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id left join acct_events ev on ev.id = l.event_id left join acct_organisers o on o.id = l.organiser_id where e.organisation_id = ${orgId} and e.livemode = ${live} and e.entry_date between ${r.from}::date and ${r.to}::date order by e.seq, l.id`),
    // Output VAT contained in booking fees earned in the period (fees are VAT-inclusive at the configured rate).
    q<{ currency: string; fees: string }>(sql`select bt.currency, coalesce(sum(bt.commission_amount), 0)::text fees from stripe_balance_transactions bt join acct_journal_entries e on e.id = bt.posted_entry_id where bt.organisation_id = ${orgId} and bt.livemode = ${live} and bt.match_status = 'MATCHED' and e.entry_date between ${r.from}::date and ${r.to}::date group by 1`),
  ]);
  const vat = outputVat.map((x) => {
    const fees = n(x.fees), out = feeIncluded(fees, inv.bookingFeeVatBps), input = books.find((b) => b.currency === x.currency)?.inputVat ?? 0;
    return { currency: x.currency, bookingFees: fees, outputVat: out, inputVat: input, netVatPayable: out - input, rateBps: inv.bookingFeeVatBps };
  });
  return { generatedAt: new Date().toISOString(), range: r, mode, companyName: inv.legalName, companyLines: registrationLines(inv), timezone: settings.timezone, books, events, eventTotals: totalsByCurrency(events), trialBalance: tb, checks, payments, expenses, bills, payslips, refunds, payouts, customerInvoices: custInv, ledger, vat };
}
export type AccountantData = Awaited<ReturnType<typeof accountantData>>;

// ---------- CSV ----------
function toCsv(rows: Array<Record<string, unknown>>, money: string[] = [], currencyKey = "currency") {
  if (!rows.length) return "﻿(no rows)\r\n";
  const cols = Object.keys(rows[0]!);
  const val = (r: Record<string, unknown>, c: string) => {
    const v = r[c];
    if (money.includes(c) && v != null) return toDecimalString(Number(v), String(r[currencyKey] ?? "eur"));
    return v;
  };
  return `﻿${cols.map(csvValue).join(",")}\r\n${rows.map((r) => cols.map((c) => csvValue(val(r, c))).join(",")).join("\r\n")}\r\n`;
}

export function accountantCsvs(d: AccountantData): Record<string, string> {
  const ev = d.events.map((e) => ({ event: e.eventName, event_code: e.eventCode, event_date: e.startsOn, organiser: e.organiserName, currency: e.currency, tickets: e.tickets, orders: e.orders, gross_sales: e.grossSales, refunds: e.refunds, chargebacks: e.chargebacks, net_sales: e.netSales, booking_fee_percent: (e.bookingFeeBps ?? 0) / 100, booking_fees: e.bookingFees, booking_fee_refunded_to_recover: e.bookingFeesRefunded, stripe_fees: e.processingFees, stripe_fees_recharged: e.feesRecharged, platform_expenses: e.expensesBilit, deductions: e.deductions, organiser_due: e.organiserDue, organiser_paid: e.organiserPaid, remaining: e.remaining, settlement: e.settlement, bilit_profit: e.bilitProfit }));
  const evMoney = ["gross_sales", "refunds", "chargebacks", "net_sales", "booking_fees", "booking_fee_refunded_to_recover", "stripe_fees", "stripe_fees_recharged", "platform_expenses", "deductions", "organiser_due", "organiser_paid", "remaining", "bilit_profit"];
  const pnl = d.books.flatMap((c) => c.lines.map((l) => ({ currency: c.currency, account_code: l.code, account: l.name, type: l.type, amount: l.amount })));
  return {
    "01_profit_and_loss_by_account.csv": toCsv(pnl, ["amount"]),
    "02_trial_balance.csv": toCsv(d.trialBalance.map((x) => ({ currency: x.currency, account_code: x.code, account: x.name, type: x.type, debit: x.debit, credit: x.credit, balance: x.balance })), ["debit", "credit", "balance"]),
    "03_vat_summary.csv": toCsv(d.vat.map((v) => ({ currency: v.currency, booking_fees_incl_vat: v.bookingFees, vat_rate_percent: v.rateBps / 100, output_vat: v.outputVat, input_vat: v.inputVat, net_vat_payable: v.netVatPayable })), ["booking_fees_incl_vat", "output_vat", "input_vat", "net_vat_payable"]),
    "04_events_settlement.csv": toCsv(ev, evMoney),
    "05_organiser_payments.csv": toCsv(d.payments, ["amount"]),
    "06_supplier_invoices_and_expenses.csv": toCsv(d.bills, ["net_amount", "vat_amount", "total_amount"]),
    "07_event_platform_expenses.csv": toCsv(d.expenses, ["amount"]),
    "08_payroll_payslips.csv": toCsv(d.payslips, ["gross_pay", "total_deductions", "net_pay", "employer_total"]),
    "09_refunds.csv": toCsv(d.refunds, ["amount", "commission_reversed"]),
    "10_stripe_payouts.csv": toCsv(d.payouts, ["amount"]),
    "11_customer_invoices_and_credit_notes.csv": toCsv(d.customerInvoices, ["net_total", "vat_total", "gross_total"]),
    "12_general_ledger.csv": toCsv(d.ledger, ["debit", "credit"]),
    "13_review_checks.csv": toCsv(d.checks.map((c) => ({ severity: c.severity, code: c.code, title: c.title, count: c.count, amounts: Object.entries(c.amounts ?? {}).map(([k, v]) => formatMoney(v, k)).join("; "), detail: c.detail }))),
  };
}

// ---------- PDF ----------
export async function accountantPdf(d: AccountantData, aiSummary?: string | null): Promise<Buffer> {
  const f = load();
  const M = 42;
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: `Accountant report ${d.range.from} to ${d.range.to}`, Author: d.companyName ?? "Bilit" } });
  doc.registerFont("reg", f.reg); doc.registerFont("bold", f.bold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - M * 2, H = doc.page.height;
  const ensure = (h: number) => { if (doc.y + h > H - M - 20) doc.addPage(); };
  const h1 = (s: string) => { ensure(60); doc.moveDown(0.6); doc.font("bold").fontSize(13).fillColor(C.primary).text(s, M, doc.y, { width: W }); doc.moveDown(0.3); };
  const p = (s: string, o: { size?: number; color?: string; bold?: boolean } = {}) => { ensure(20); doc.font(o.bold ? "bold" : "reg").fontSize(o.size ?? 9).fillColor(o.color ?? C.text).text(s, M, doc.y, { width: W }); };
  const m = (v: number, c: string) => formatMoney(v, c, "en");
  const table = (head: string[], rows: string[][], widths: number[], right: number[] = [], fs = 8) => {
    const tw = widths.reduce((s, x) => s + x, 0), k = W / tw, ws = widths.map((x) => x * k);
    const row = (cells: string[], bold = false, fill?: string) => {
      const hh = Math.max(14, ...cells.map((c, i) => doc.font(bold ? "bold" : "reg").fontSize(fs).heightOfString(c, { width: ws[i]! - 6 }) + 5));
      ensure(hh + 2);
      const y = doc.y;
      if (fill) doc.rect(M, y, W, hh).fill(fill);
      let x = M;
      cells.forEach((c, i) => { doc.font(bold ? "bold" : "reg").fontSize(fs).fillColor(C.text).text(c, x + 3, y + 3, { width: ws[i]! - 6, align: right.includes(i) ? "right" : "left" }); x += ws[i]!; });
      doc.y = y + hh;
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.3).strokeColor(C.rule).stroke();
    };
    row(head, true, C.tint);
    if (!rows.length) row([`None in this period.`, ...head.slice(1).map(() => "")]);
    for (const r of rows) row(r);
    doc.moveDown(0.5);
  };

  // Cover
  doc.font("bold").fontSize(20).fillColor(C.text).text(d.companyName ?? "Bilit", M, M + 10);
  if (d.companyLines.length) doc.font("reg").fontSize(8.5).fillColor(C.muted).text(d.companyLines.join(" · "), M, doc.y + 2);
  doc.font("bold").fontSize(14).fillColor(C.primary).text("Accountant report", M, doc.y + 4);
  p(`Period ${d.range.from} to ${d.range.to} · ${d.mode === "live" ? "Live" : "TEST"} data · generated ${d.generatedAt.slice(0, 16).replace("T", " ")} UTC`, { color: C.muted });
  p("All amounts are in the currency they were transacted in; currencies are never added together. Figures come from the double-entry ledger, which is balanced (total debits = total credits) and append-only. Detailed CSV files are included in the same pack.", { color: C.muted });

  if (aiSummary) { h1("AI bookkeeping review (summary)"); p(aiSummary, { size: 8.5 }); }

  h1("Review checks");
  if (!d.checks.length) p("No issues found by the automated checks.");
  else table(["Severity", "Check", "Count", "Amount", "What to do"], d.checks.map((c) => [c.severity.toUpperCase(), c.title, String(c.count), Object.entries(c.amounts ?? {}).map(([k, v]) => m(v, k)).join("\n"), c.detail]), [11, 26, 8, 15, 40], [2, 3]);

  for (const c of d.books) {
    h1(`Profit & loss — ${c.currency.toUpperCase()}`);
    table(["Account", "Type", "Amount"], [...c.lines.map((l) => [`${l.code} ${l.name}`, l.type === "REVENUE" ? "Income" : "Cost", m(l.amount, c.currency)]), ["Total income", "", m(c.revenue, c.currency)], ["Total costs", "", m(c.expenses, c.currency)], ["NET PROFIT", "", m(c.netProfit, c.currency)]], [60, 15, 25], [2]);
  }

  h1("VAT summary");
  p("Output VAT is the VAT contained in booking fees (VAT-inclusive at the configured rate). Ticket money is collected as agent for organisers unless configured otherwise. Input VAT is from supplier invoices and expenses. Confirm the treatment before filing.", { color: C.muted, size: 8 });
  table(["Currency", "Booking fees (incl. VAT)", "Rate", "Output VAT", "Input VAT", "Net payable"], d.vat.map((v) => [v.currency.toUpperCase(), m(v.bookingFees, v.currency), `${v.rateBps / 100}%`, m(v.outputVat, v.currency), m(v.inputVat, v.currency), m(v.netVatPayable, v.currency)]), [12, 22, 10, 18, 18, 20], [1, 3, 4, 5]);

  h1("Events — sales, booking fees and organiser settlement");
  table(["Event", "Cur", "Gross", "Refunds", "Booking fee", "Due", "Paid", "Remaining", "Profit"], d.events.filter((e) => e.grossSales || e.organiserDue || e.organiserPaid).map((e) => [`${e.eventName} (${e.eventCode})`, e.currency.toUpperCase(), m(e.grossSales, e.currency), m(e.refunds + e.chargebacks, e.currency), m(e.bookingFees, e.currency), m(e.organiserDue, e.currency), m(e.organiserPaid, e.currency), m(e.remaining, e.currency), m(e.bilitProfit, e.currency)]), [20, 5, 12, 9, 11, 12, 9, 12, 12], [2, 3, 4, 5, 6, 7, 8], 7);
  table(["Totals", "Gross", "Booking fees", "Fee to recover", "Due", "Paid", "Remaining", "Profit"], d.eventTotals.map((t) => [t.currency.toUpperCase(), m(t.grossSales, t.currency), m(t.bookingFees, t.currency), m(t.bookingFeesRefunded, t.currency), m(t.organiserDue, t.currency), m(t.organiserPaid, t.currency), m(t.remaining, t.currency), m(t.bilitProfit, t.currency)]), [8, 14, 13, 12, 14, 12, 14, 13], [1, 2, 3, 4, 5, 6, 7], 7);

  h1("Payments made to organisers");
  table(["Date", "Organiser", "Event", "Amount", "Method", "Reference", "Status"], d.payments.map((r) => [String(r.payment_date), String(r.organiser), String(r.event ?? "—"), m(n(r.amount), String(r.currency)), String(r.method), String(r.bank_reference ?? ""), String(r.status)]), [12, 20, 22, 13, 11, 13, 9], [3]);

  h1("Supplier invoices & expenses");
  table(["Date", "Supplier", "Category", "Net", "VAT", "Total", "Status", "Doc"], d.bills.map((r) => [String(r.invoice_date), `${r.supplier_name}${r.invoice_number ? ` #${r.invoice_number}` : ""}`, String(r.account), m(n(r.net_amount), String(r.currency)), m(n(r.vat_amount), String(r.currency)), m(n(r.total_amount), String(r.currency)), String(r.status), r.has_document ? "yes" : "MISSING"]), [11, 24, 18, 11, 9, 11, 9, 7], [3, 4, 5]);
  if (d.expenses.length) table(["Date", "Event", "Expense", "Category", "Amount", "Receipt"], d.expenses.map((r) => [String(r.expense_date), String(r.event), String(r.name), String(r.category), m(n(r.amount), String(r.currency)), r.has_receipt ? "yes" : "MISSING"]), [12, 24, 26, 14, 14, 10], [4]);

  h1("Payroll");
  table(["Payslip", "Pay date", "Employee", "Gross", "Deductions", "Net", "Employer", "Status"], d.payslips.map((r) => [String(r.number), String(r.pay_date), String(r.employee), m(n(r.gross_pay), String(r.currency)), m(n(r.total_deductions), String(r.currency)), m(n(r.net_pay), String(r.currency)), m(n(r.employer_total), String(r.currency)), String(r.status)]), [14, 11, 20, 12, 12, 12, 11, 8], [3, 4, 5, 6]);

  h1("Refunds");
  table(["Date", "Event", "Amount", "Status", "Booking fee kept", "Note"], d.refunds.map((r) => [String(r.stripe_created_at).slice(0, 10), String(r.event ?? "—"), m(n(r.amount), String(r.currency)), String(r.status ?? ""), r.keep_booking_fee || !n(r.commission_reversed) ? "yes" : "no", String(r.note ?? "")]), [12, 30, 13, 11, 12, 22], [2]);

  h1("Stripe payouts to bank");
  table(["Created", "Arrival", "Amount", "Status", "Transactions", "Reconciliation"], d.payouts.map((r) => [String(r.stripe_created_at).slice(0, 10), String(r.arrival_date ?? "").slice(0, 10), m(n(r.amount), String(r.currency)), String(r.status), String(r.included_count ?? ""), String(r.reconciliation_status)]), [15, 15, 18, 14, 16, 22], [2, 4]);

  h1("Trial balance (as of period end)");
  table(["Cur", "Account", "Debit", "Credit", "Balance"], d.trialBalance.map((x) => [x.currency.toUpperCase(), `${x.code} ${x.name}`, m(x.debit, x.currency), m(x.credit, x.currency), m(x.balance, x.currency)]), [7, 45, 16, 16, 16], [2, 3, 4]);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would make pdfkit start a new page; lift the margin while drawing the footer.
    const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font("reg").fontSize(7).fillColor(C.muted).text(`${d.companyName ?? "Bilit"} · Accountant report ${d.range.from} – ${d.range.to} · page ${i + 1} of ${range.count}`, M, H - M + 8, { width: W, align: "center", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

export async function accountantZip(d: AccountantData, aiSummary?: string | null) {
  const pdf = await accountantPdf(d, aiSummary);
  const files: Record<string, Uint8Array> = { "00_accountant_report.pdf": new Uint8Array(pdf) };
  for (const [k, v] of Object.entries(accountantCsvs(d))) files[k] = strToU8(v);
  return Buffer.from(zipSync(files, { level: 6 }));
}
