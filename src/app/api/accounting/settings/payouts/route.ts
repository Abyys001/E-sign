import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { getPayoutSettings, PayoutSettingsInput, updatePayoutSettings } from "@/server/accounting/stripe-payouts";

/** Stripe Global Payouts key (write-only: only a masked hint is returned) + the financial account payments are sent from. */
export const GET = acct("accounting.view", async ({ auth, mode }) => getPayoutSettings(auth.organisationId, mode));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, PayoutSettingsInput);
  if (b.apiKey !== undefined) requireElevation(auth);
  return updatePayoutSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, b);
});
