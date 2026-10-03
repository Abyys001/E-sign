import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { listTransactions, TxFilter } from "@/server/accounting/queries";
import { csvStream, paged } from "@/server/accounting/reports";

type T = Awaited<ReturnType<typeof listTransactions>>["items"][number];
const TX_CSV = [
  { header: "date_utc", value: (r: T) => r.stripeCreatedAt }, { header: "stripe_balance_transaction", value: (r: T) => r.balanceTransactionId }, { header: "type", value: (r: T) => r.type },
  { header: "kind", value: (r: T) => r.kind }, { header: "source", value: (r: T) => r.sourceId }, { header: "stripe_charge", value: (r: T) => r.chargeId },
  { header: "amount", value: (r: T) => r.amount, money: (r: T) => r.currency }, { header: "stripe_fee", value: (r: T) => r.fee, money: (r: T) => r.currency }, { header: "net", value: (r: T) => r.net, money: (r: T) => r.currency },
  { header: "currency", value: (r: T) => r.currency.toUpperCase() }, { header: "exchange_rate", value: (r: T) => r.exchangeRate },
  { header: "event_code", value: (r: T) => r.eventCode }, { header: "event", value: (r: T) => r.eventName }, { header: "organiser", value: (r: T) => r.organiserName },
  { header: "commission", value: (r: T) => r.commissionAmount ?? 0, money: (r: T) => r.currency }, { header: "organiser_payable_change", value: (r: T) => r.organiserAmount ?? 0, money: (r: T) => r.currency },
  { header: "match_status", value: (r: T) => r.matchStatus }, { header: "match_reason", value: (r: T) => r.matchReason }, { header: "accounting_status", value: (r: T) => r.reconciliationStatus },
  { header: "payout", value: (r: T) => r.payoutId }, { header: "description", value: (r: T) => r.description }, { header: "mode", value: (r: T) => (r.livemode ? "live" : "test") },
];

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, TxFilter.and(Pagination).and(z.object({ format: z.enum(["csv"]).optional(), mode: z.string().optional() })));
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    return csvResponse(csvStream(TX_CSV, paged(async (limit, offset) => (await listTransactions(auth.organisationId, mode, q, { limit, offset }, false)).items)), `stripe-transactions-${mode}`);
  }
  const r = await listTransactions(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
  return { ...r, page: q.page, pageSize: q.pageSize, mode };
});
