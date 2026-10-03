import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { classifyTransaction, ClassifyInput } from "@/server/accounting/manual";

export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  classifyTransaction({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Transaction"), await body(req, ClassifyInput)));
