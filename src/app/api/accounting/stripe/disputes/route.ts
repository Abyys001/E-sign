import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { listDisputes } from "@/server/accounting/queries";

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Pagination.passthrough());
  return { ...(await listDisputes(auth.organisationId, mode, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});
