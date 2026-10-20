import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { CallSettingsInput, getCallSettings, updateCallSettings } from "@/server/accounting/ai-call";

/** Voice call settings for the AI Accountant. The ElevenLabs key is write-only (only a masked hint is ever returned). */
export const GET = acct("accounting.view", async ({ auth }) => getCallSettings(auth.organisationId));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, CallSettingsInput);
  if (b.elevenApiKey !== undefined) requireElevation(auth);
  return updateCallSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, b);
});
