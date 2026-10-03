import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { IsoDate } from "@/server/accounting/core";
import { listPayouts } from "@/server/accounting/queries";
import { csvStream, paged } from "@/server/accounting/reports";

const Q = Pagination.extend({ status: z.string().max(20).optional(), from: IsoDate.optional(), to: IsoDate.optional(), format: z.enum(["csv"]).optional() }).passthrough();
type P = Awaited<ReturnType<typeof listPayouts>>["items"][number];

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    return csvResponse(csvStream<P>([
      { header: "payout_id", value: (r) => r.payoutId }, { header: "created_utc", value: (r) => r.stripeCreatedAt }, { header: "arrival_date_utc", value: (r) => r.arrivalDate },
      { header: "amount", value: (r) => r.amount, money: (r) => r.currency }, { header: "currency", value: (r) => r.currency.toUpperCase() }, { header: "status", value: (r) => r.status },
      { header: "automatic", value: (r) => r.automatic }, { header: "stripe_account", value: (r) => r.stripeAccountId }, { header: "included_transactions", value: (r) => r.includedCount },
      { header: "included_net", value: (r) => r.includedNet ?? 0, money: (r) => r.currency }, { header: "reconciliation_status", value: (r) => r.reconciliationStatus }, { header: "mode", value: () => mode },
    ], paged(async (limit, offset) => (await listPayouts(auth.organisationId, mode, { limit, offset }, q)).items)), `payouts-${mode}`);
  }
  return { ...(await listPayouts(auth.organisationId, mode, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize }, q)), page: q.page, pageSize: q.pageSize };
});
