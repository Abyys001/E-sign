import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { DecisionInput, decideLimitRequest } from "@/server/treasury/admin";
export const POST = acct<{ id: string }>("treasury.admin", async ({ req, auth, ctx, params }) => { requireElevation(auth); return decideLimitRequest({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, uuid(params.id, "Request"), await body(req, DecisionInput)); });
