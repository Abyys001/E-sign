import { acct } from "@/server/accounting/http";
import { syncPayouts } from "@/server/accounting/stripe-payouts";

export const POST = acct("accounting.manage", async ({ auth, ctx, mode }) => syncPayouts(auth.organisationId, mode, { orgId: auth.organisationId, userId: auth.user.id, ctx }));
