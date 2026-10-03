import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { RefundFilter, refundsOverview } from "@/server/accounting/refunds";

/** Refunds & chargebacks with their sale, event link, ticket/booking-fee split and Stripe status. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Pagination.merge(RefundFilter).passthrough());
  return { ...(await refundsOverview(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize, mode };
});
