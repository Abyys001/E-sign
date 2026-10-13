import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { getXeSettings, updateXeSettings, XeSettingsInput } from "@/server/accounting/xe";

/** XE Currency Data API connection for converted totals. The API key is write-only (only a masked hint is returned). */
export const GET = acct("accounting.view", async ({ auth }) => getXeSettings(auth.organisationId));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, XeSettingsInput);
  if (b.apiKey !== undefined) requireElevation(auth);
  return updateXeSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, b);
});
