import { sql } from "drizzle-orm";
import { db } from "@/db";
import { verifyOrgAuditChain } from "../audit";
import { AppError } from "../errors";

/**
 * Month-end close checklist. Closing a month locks it (the database rejects new postings into it), so before that the
 * month's loose ends are listed: unreconciled Stripe activity, sales without an event, suspense, pending organiser
 * payments, draft payslips, unbooked Wise transfers, missing receipts, earlier months still open, and whether the
 * organisation's audit hash chain still verifies. Items are
 * warnings, not blockers — closing with open items is allowed once the admin acknowledges them; the list is stored
 * in the audit trail with the close. Live data only (periods are organisation-wide; test data never matters for a close).
 */
export type CloseItem = { code: string; severity: "high" | "medium" | "low"; title: string; detail: string; count: number; href?: string };
export type Checklist = { period: string; from: string; to: string; items: CloseItem[]; ready: boolean };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export function periodRange(period: string) {
  if (!PERIOD.test(period)) throw new AppError("validation_failed", "Use a month like 2026-09.", [{ path: "period", message: "YYYY-MM" }]);
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

export async function periodChecklist(orgId: string, period: string, today = new Date().toISOString().slice(0, 10)): Promise<Checklist> {
  const { from, to } = periodRange(period);
  if (from > today) throw new AppError("validation_failed", "A month that has not started cannot be closed.", [{ path: "period", message: "Future month" }]);
  const one = async (s: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(s)).rows[0]?.n ?? 0);
  const [chain, unrec, unmatched, suspense, pending, drafts, wise, receipts, earlier] = await Promise.all([
    verifyOrgAuditChain(orgId),
    one(sql`select count(*)::int n from stripe_balance_transactions where organisation_id = ${orgId} and livemode and reconciliation_status in ('UNMATCHED','PARTIAL','DUPLICATE','MANUAL_REVIEW','ERROR') and stripe_created_at::date between ${from}::date and ${to}::date`),
    one(sql`select count(*)::int n from stripe_balance_transactions where organisation_id = ${orgId} and livemode and kind = 'SALE' and match_status = 'UNMATCHED' and stripe_created_at::date between ${from}::date and ${to}::date`),
    one(sql`select count(*)::int n from (select e.currency from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
      where e.organisation_id = ${orgId} and e.livemode and a.system_key = 'unclassified' and e.entry_date <= ${to}::date group by 1 having sum(l.debit - l.credit) <> 0) x`),
    one(sql`select count(*)::int n from acct_organiser_payments where organisation_id = ${orgId} and livemode and status = 'PENDING' and payment_date <= ${to}::date`),
    one(sql`select count(*)::int n from acct_payslips where organisation_id = ${orgId} and livemode and status = 'DRAFT' and pay_date between ${from}::date and ${to}::date`),
    one(sql`select count(*)::int n from acct_wise_transactions where organisation_id = ${orgId} and direction = 'OUT' and kind = 'TRANSFER' and not ignored and organiser_payment_id is null and bill_id is null and partner_payment_id is null
      and status not in ('cancelled','bounced_back','funds_refunded','charged_back') and occurred_at::date between ${from}::date and ${to}::date`),
    one(sql`select count(*)::int n from acct_bills where organisation_id = ${orgId} and livemode and status <> 'VOIDED' and file_object_id is null and invoice_date between ${from}::date and ${to}::date`),
    // Earlier months that have postings but are not closed: closing out of order leaves gaps in the lock.
    one(sql`select count(*)::int n from (select distinct to_char(entry_date, 'YYYY-MM') p from acct_journal_entries where organisation_id = ${orgId} and livemode and entry_date < ${from}::date) m
      where not exists (select 1 from acct_periods ap where ap.organisation_id = ${orgId} and ap.period = m.p and ap.status = 'CLOSED')`),
  ]);
  const items: CloseItem[] = [];
  const add = (c: CloseItem) => { if (c.count > 0) items.push(c); };
  // Tamper evidence: the accounting audit trail is a hash chain; a break means a record was altered outside the app.
  add({ code: "AUDIT_CHAIN", severity: "high", title: "The accounting audit trail does not verify", detail: `The hash chain breaks at audit event #${chain.brokenAtSeq}. Do not close; investigate who changed the records.`, count: chain.ok ? 0 : 1 });
  add({ code: "MONTH_NOT_OVER", severity: "high", title: "The month is not over yet", detail: "Payments still coming in this month would have to be booked in a later month.", count: to >= today ? 1 : 0 });
  add({ code: "EARLIER_OPEN", severity: "medium", title: "Earlier months are still open", detail: "Close months in order, so older figures cannot change after a later month is reported.", count: earlier, href: "/accounting/ledger" });
  add({ code: "UNRECONCILED", severity: "high", title: "Stripe transactions in this month need review", detail: "Unmatched, partial, duplicate or manual-review transactions.", count: unrec, href: "/accounting/reconciliation" });
  add({ code: "UNMATCHED_SALES", severity: "high", title: "Sales without an event", detail: "Create the events or assign the sales so organisers' balances are complete.", count: unmatched, href: "/accounting/transactions?status=UNMATCHED" });
  add({ code: "SUSPENSE", severity: "high", title: "Balance on the suspense account", detail: "Unclassified Stripe activity (e.g. top-ups) must be classified.", count: suspense, href: "/accounting/reconciliation" });
  add({ code: "PENDING_PAYMENTS", severity: "medium", title: "Organiser payments still pending", detail: "Mark them paid or void them.", count: pending, href: "/accounting/payments" });
  add({ code: "DRAFT_PAYSLIPS", severity: "medium", title: "Draft payslips for this month", detail: "Finalise or delete them; drafts are not in the books.", count: drafts, href: "/accounting/books/payslips" });
  add({ code: "WISE_UNBOOKED", severity: "medium", title: "Wise transfers not in the books", detail: "Outgoing transfers this month that are not linked to a payment, invoice or partner payment.", count: wise, href: "/accounting/wise" });
  add({ code: "MISSING_RECEIPTS", severity: "low", title: "Invoices/expenses without a document", detail: "Upload the supplier invoice or receipt.", count: receipts, href: "/accounting/books/invoices" });
  return { period, from, to, items, ready: items.length === 0 };
}
