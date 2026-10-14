import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { Currency, IsoDate } from "@/server/accounting/core";
import { csvStream, type CsvColumn } from "@/server/accounting/reports";
import { eventFinancials, SETTLEMENT_STATUSES, totalsByCurrency, type EventFinanceRow, type SettlementStatus } from "@/server/accounting/finance";

const Q = Pagination.extend({
  from: IsoDate.optional(), to: IsoDate.optional(), q: z.string().trim().max(120).optional(), organiserId: z.string().uuid().optional(), currency: Currency.optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "CANCELLED", "ARCHIVED"]).optional(), settlement: z.enum(SETTLEMENT_STATUSES as [SettlementStatus, ...SettlementStatus[]]).optional(),
  payments: z.enum(["PENDING", "NONE"]).optional(), eventId: z.string().uuid().optional(), format: z.enum(["csv"]).optional(),
  sort: z.enum(["date", "name", "grossSales", "netSales", "refunds", "processingFees", "organiserDue", "remaining", "bilitProfit", "tickets"]).optional(), dir: z.enum(["asc", "desc"]).default("desc"),
}).passthrough();

const cur = (r: EventFinanceRow) => r.currency;
const COLS: CsvColumn<EventFinanceRow>[] = [
  { header: "event", value: (r) => r.eventName }, { header: "event_code", value: (r) => r.eventCode }, { header: "event_date", value: (r) => r.startsOn }, { header: "status", value: (r) => r.eventStatus },
  { header: "organiser", value: (r) => r.organiserName }, { header: "currency", value: (r) => r.currency.toUpperCase() }, { header: "tickets", value: (r) => r.tickets }, { header: "orders", value: (r) => r.orders },
  { header: "gross_sales", value: (r) => r.grossSales, money: cur }, { header: "refunds", value: (r) => r.refunds, money: cur }, { header: "chargebacks", value: (r) => r.chargebacks, money: cur },
  { header: "booking_fee_percent", value: (r) => (r.bookingFeeBps ?? 0) / 100 }, { header: "booking_fees", value: (r) => r.bookingFees, money: cur }, { header: "processing_fees", value: (r) => r.processingFees, money: cur },
  { header: "processing_fees_recharged", value: (r) => r.feesRecharged, money: cur }, { header: "expenses_bilit", value: (r) => r.expensesBilit, money: cur }, { header: "deductions", value: (r) => r.deductions, money: cur },
  { header: "organiser_due", value: (r) => r.organiserDue, money: cur }, { header: "organiser_paid", value: (r) => r.organiserPaid, money: cur }, { header: "remaining", value: (r) => r.remaining, money: cur },
  { header: "settlement_status", value: (r) => r.settlement }, { header: "bilit_profit", value: (r) => r.bilitProfit, money: cur },
];

/** Event financial summary table (filterable); CSV export with the same filters. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  const rows = await eventFinancials(auth.organisationId, mode, { ...q, eventIds: q.eventId ? [q.eventId] : undefined });
  if (q.sort) { // default order (newest event first) is kept unless a column is chosen; amounts compare within one currency only as numbers
    const k = q.sort, m = q.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => m * (k === "date" ? (a.startsOn ?? "").localeCompare(b.startsOn ?? "") : k === "name" ? a.eventName.localeCompare(b.eventName) : (a[k] as number) - (b[k] as number)));
  }
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    return csvResponse(csvStream(COLS, async () => ({ rows, more: false })), `event-financials-${mode}-${q.from ?? "all"}-${q.to ?? "now"}`);
  }
  const start = (q.page - 1) * q.pageSize;
  return { items: rows.slice(start, start + q.pageSize), total: rows.length, totals: totalsByCurrency(rows), page: q.page, pageSize: q.pageSize, mode };
});
