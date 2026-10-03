import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { AiSettingsInput, getAiSettings, updateAiSettings } from "@/server/accounting/ai";

/** OpenAI settings for the AI accountant. The API key is write-only (only a masked hint is ever returned). */
export const GET = acct("accounting.view", async ({ auth }) => getAiSettings(auth.organisationId));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, AiSettingsInput);
  if (b.apiKey !== undefined) requireElevation(auth);
  return updateAiSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, b);
});
