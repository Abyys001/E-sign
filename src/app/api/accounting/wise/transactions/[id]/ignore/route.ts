import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { IgnoreInput, setWiseIgnored } from "@/server/accounting/wise";

/** Mark a Wise transfer as not an organiser payment (supplier, own account…), or undo that. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  setWiseIgnored({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Transaction"), await body(req, IgnoreInput)));
