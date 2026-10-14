import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { listAudit } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ req, auth }) => {
  const q = query(req, Pagination);
  return { ...(await listAudit(auth.organisationId, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});
