import { acct } from "@/server/accounting/http";
import { requireElevation, uuid } from "@/server/api";
import { cancelPayout } from "@/server/accounting/stripe-payouts";

export const POST = acct<{ id: string }>("accounting.admin", async ({ auth, ctx, params }) => {
  requireElevation(auth);
  return cancelPayout({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Payment"));
});
