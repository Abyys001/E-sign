import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { BillPay, payBill } from "@/server/accounting/books";

export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => payBill({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Document"), await body(req, BillPay)));
