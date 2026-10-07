import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { WiseFilter, listWise } from "@/server/accounting/wise";

const Q = Pagination.merge(WiseFilter);
export const GET = acct("accounting.view", async ({ req, auth }) => {
  const q = query(req, Q);
  return { ...(await listWise(auth.organisationId, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});
