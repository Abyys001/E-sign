import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { BillEdit, editBill } from "@/server/accounting/books";

export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => editBill({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Document"), await body(req, BillEdit)));
