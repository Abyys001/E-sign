import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { IsoDate } from "@/server/accounting/core";
import { csvStream, eventProfitRows, paged, salesRows, type CsvColumn } from "@/server/accounting/reports";
import { listTransactions } from "@/server/accounting/queries";

const Q = Pagination.extend({
  from: IsoDate.optional(), to: IsoDate.optional(), eventId: z.string().uuid().optional(), organiserId: z.string().uuid().optional(), status: z.string().max(30).optional(), format: z.enum(["csv"]).optional(),
}).passthrough();

type S = Awaited<ReturnType<typeof salesRows>>[number];
type E = Awaited<ReturnType<typeof eventProfitRows>>[number];
type T = Awaited<ReturnType<typeof listTransactions>>["items"][number];
const cur = (r: { currency: string }) => r.currency;

const SALES: CsvColumn<S>[] = [
  { header: "date_utc", value: (r) => r.date }, { header: "event", value: (r) => r.eventName }, { header: "event_code", value: (r) => r.eventCode }, { header: "organiser", value: (r) => r.organiserName },
  { header: "order", value: (r) => r.order }, { header: "stripe_payment", value: (r) => r.stripePayment }, { header: "gross", value: (r) => r.gross, money: cur }, { header: "refund", value: (r) => r.refunded, money: cur },
  { header: "chargeback", value: (r) => r.chargeback, money: cur }, { header: "net_gross", value: (r) => r.netGross, money: cur }, { header: "stripe_fee", value: (r) => r.stripeFee, money: cur },
  { header: "net", value: (r) => r.net, money: cur }, { header: "commission", value: (r) => r.commission, money: cur }, { header: "currency", value: (r) => r.currency.toUpperCase() }, { header: "status", value: (r) => r.status },
];
const EVENTS: CsvColumn<E>[] = [
  { header: "event", value: (r) => r.eventName }, { header: "event_code", value: (r) => r.eventCode }, { header: "organiser", value: (r) => r.organiserName }, { header: "currency", value: (r) => r.currency.toUpperCase() },
  { header: "gross_sales", value: (r) => r.grossSales, money: cur }, { header: "refunds", value: (r) => r.refunds, money: cur }, { header: "chargebacks", value: (r) => r.chargebacks, money: cur },
  { header: "stripe_fees", value: (r) => r.stripeFees, money: cur }, { header: "stripe_fees_recharged", value: (r) => r.stripeFeesRecharged, money: cur }, { header: "commission", value: (r) => r.commission, money: cur },
  { header: "other_costs", value: (r) => r.otherCosts, money: cur }, { header: "organiser_payable", value: (r) => r.organiserPayable, money: cur }, { header: "organiser_paid", value: (r) => r.organiserPaid, money: cur },
  { header: "organiser_outstanding", value: (r) => r.organiserOutstanding, money: cur }, { header: "bilit_profit", value: (r) => r.bilitProfit, money: cur },
];
const RECON: CsvColumn<T>[] = [
  { header: "stripe_transaction", value: (r) => r.balanceTransactionId }, { header: "date_utc", value: (r) => r.stripeCreatedAt }, { header: "type", value: (r) => r.type }, { header: "kind", value: (r) => r.kind },
  { header: "amount", value: (r) => r.amount, money: cur }, { header: "fee", value: (r) => r.fee, money: cur }, { header: "net", value: (r) => r.net, money: cur }, { header: "currency", value: (r) => r.currency.toUpperCase() },
  { header: "event", value: (r) => r.eventName }, { header: "event_code", value: (r) => r.eventCode }, { header: "organiser", value: (r) => r.organiserName },
  { header: "accounting_status", value: (r) => r.reconciliationStatus }, { header: "match_reason", value: (r) => r.matchReason }, { header: "note", value: (r) => r.reconciliationNote },
];

/** Reports: sales, event-profit, reconciliation. JSON (paginated) for the screen, CSV (streamed, Excel-compatible) for export. */
export const GET = acct<{ report: string }>("accounting.view", async ({ req, auth, params, mode }) => {
  const q = query(req, Q);
  const range = { from: q.from, to: q.to };
  const org = auth.organisationId;
  const fetchers = {
    sales: { cols: SALES, fetch: (limit: number, offset: number) => salesRows(org, mode, range, { limit, offset }, q) },
    "event-profit": { cols: EVENTS, fetch: (limit: number, offset: number) => eventProfitRows(org, mode, range, { limit, offset }, q.organiserId) },
    reconciliation: { cols: RECON, fetch: async (limit: number, offset: number) => (await listTransactions(org, mode, { ...range, status: q.status, eventId: q.eventId, organiserId: q.organiserId }, { limit, offset }, false)).items },
  } as const;
  const f = fetchers[params.report as keyof typeof fetchers];
  if (!f) throw new AppError("not_found", "Unknown report");
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    return csvResponse(csvStream(f.cols as CsvColumn<unknown>[], paged((l, o) => f.fetch(l, o) as Promise<unknown[]>)), `${params.report}-${mode}-${q.from ?? "all"}-${q.to ?? "now"}`);
  }
  const rows = await f.fetch(q.pageSize + 1, (q.page - 1) * q.pageSize);
  return { items: rows.slice(0, q.pageSize), hasMore: rows.length > q.pageSize, page: q.page, pageSize: q.pageSize, mode };
});
