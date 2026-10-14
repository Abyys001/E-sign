import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { listExpensesAdmin } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ req, auth, mode }) => {
  const q = query(req, Pagination);
  return { items: await listExpensesAdmin(auth.organisationId, mode, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize }), page: q.page, pageSize: q.pageSize };
});
