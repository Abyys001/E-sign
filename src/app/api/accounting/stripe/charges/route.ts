import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { ChargeFilter, listCharges } from "@/server/accounting/refunds";

/** Every Stripe payment, including failed, pending and disputed ones, with decline reasons, risk and card. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Pagination.merge(ChargeFilter).passthrough());
  return { ...(await listCharges(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize, mode };
});
