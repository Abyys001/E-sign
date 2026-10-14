import { acct } from "@/server/accounting/http";
import { requireElevation, uuid } from "@/server/api";
import { revokeAssignment } from "@/server/treasury/admin";
export const POST = acct<{ id: string }>("treasury.admin", async ({ auth, ctx, params }) => { requireElevation(auth); return revokeAssignment({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, uuid(params.id, "Card")); });
