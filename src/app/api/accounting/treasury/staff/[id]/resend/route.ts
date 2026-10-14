import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { resendInvite } from "@/server/treasury/admin";
export const POST = acct<{ id: string }>("treasury.admin", async ({ auth, ctx, params }) => resendInvite({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, uuid(params.id, "Staff")));
