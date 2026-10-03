import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { csvStream, paged, type CsvColumn } from "@/server/accounting/reports";
import { BillFilter, BillInput, createBill, listBills } from "@/server/accounting/books";

type B = Awaited<ReturnType<typeof listBills>>["items"][number];
const cur = (r: B) => r.currency;
const COLS: CsvColumn<B>[] = [
  { header: "type", value: (r) => r.kind }, { header: "date", value: (r) => r.invoiceDate }, { header: "supplier", value: (r) => r.supplierName }, { header: "supplier_vat", value: (r) => r.supplierVat },
  { header: "country", value: (r) => r.country }, { header: "invoice_number", value: (r) => r.invoiceNumber }, { header: "category", value: (r) => `${r.accountCode} ${r.accountName}` }, { header: "event", value: (r) => r.eventName },
  { header: "net", value: (r) => r.netAmount, money: cur }, { header: "vat", value: (r) => r.vatAmount, money: cur }, { header: "total", value: (r) => r.totalAmount, money: cur }, { header: "currency", value: (r) => r.currency.toUpperCase() },
  { header: "status", value: (r) => r.status }, { header: "due_date", value: (r) => r.dueDate }, { header: "paid_date", value: (r) => r.paidDate }, { header: "paid_from", value: (r) => r.paidFrom },
  { header: "payment_reference", value: (r) => r.paymentReference }, { header: "description", value: (r) => r.description }, { header: "file", value: (r) => r.fileName },
];

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Pagination.merge(BillFilter).extend({ format: z.enum(["csv"]).optional() }).passthrough());
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    return csvResponse(csvStream(COLS, paged(async (limit, offset) => (await listBills(auth.organisationId, mode, q, { limit, offset })).items)), `invoices-expenses-${mode}`);
  }
  return { ...(await listBills(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize, mode };
});

/** Record a supplier invoice or a manual expense; it is posted to the ledger immediately. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => createBill({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, BillInput)));
