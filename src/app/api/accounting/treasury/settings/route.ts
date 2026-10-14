import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { getTreasurySettings, TreasurySettingsInput, updateTreasurySettings } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ auth, mode }) => getTreasurySettings(auth.organisationId, mode));
export const PATCH = acct("treasury.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, TreasurySettingsInput);
  if (b.apiKey !== undefined || b.webhookSecret !== undefined) requireElevation(auth);
  return updateTreasurySettings({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, b);
});
