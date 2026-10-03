import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { query } from "@/server/http";
import { Pagination } from "@/server/api";
import { IsoDate } from "@/server/accounting/core";
import { listCustomerInvoices } from "@/server/accounting/invoices";

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Pagination.extend({ kind: z.enum(["INVOICE", "CREDIT_NOTE"]).optional(), q: z.string().trim().max(120).optional(), from: IsoDate.optional(), to: IsoDate.optional() }).passthrough());
  return { ...(await listCustomerInvoices(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize, mode };
});
