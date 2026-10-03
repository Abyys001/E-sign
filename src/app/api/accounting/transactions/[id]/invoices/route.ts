import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { invoicesFor, issueCustomerInvoice, IssueInput } from "@/server/accounting/invoices";

/** Invoices and credit notes for this payment (the sale and all its refunds). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const bt = schema.stripeBalanceTransactions;
  const [row] = await db.select().from(bt).where(and(eq(bt.id, uuid(params.id, "Transaction")), eq(bt.organisationId, auth.organisationId)));
  if (!row) throw new AppError("not_found", "Transaction not found");
  const related = row.chargeId ? await db.select({ id: bt.id }).from(bt).where(and(eq(bt.stripeAccountRef, row.stripeAccountRef), eq(bt.chargeId, row.chargeId))) : [{ id: row.id }];
  return { items: await invoicesFor(auth.organisationId, related.map((r) => r.id)) };
});

/** Issue an invoice (sale) or credit note (refund) for this transaction; `vatInvoice` + customer details for a VAT invoice. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => issueCustomerInvoice({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Transaction"), await body(req, IssueInput)));
