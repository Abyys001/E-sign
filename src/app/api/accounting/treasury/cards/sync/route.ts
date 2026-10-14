import { acct } from "@/server/accounting/http";
import { syncFromStripe } from "@/server/treasury/admin";
export const POST = acct("treasury.admin", async ({ auth, ctx, mode }) => syncFromStripe({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, mode));
