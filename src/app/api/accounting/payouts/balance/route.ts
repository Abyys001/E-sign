import { acct } from "@/server/accounting/http";
import { getPayoutSettings, payoutBalance } from "@/server/accounting/stripe-payouts";

export const GET = acct("accounting.view", async ({ auth, mode }) => {
  const s = await getPayoutSettings(auth.organisationId, mode);
  return { connected: s.connected && !!s.financialAccountId, financialAccount: s.connected && s.financialAccountId ? await payoutBalance(auth.organisationId, mode) : null };
});
