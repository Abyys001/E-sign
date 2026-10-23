import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { getTelegramSettings, TelegramSettingsInput, updateTelegramSettings } from "@/server/accounting/telegram";

/** Telegram finance assistant settings. The bot token is write-only (only a masked hint is ever returned). */
export const GET = acct("accounting.view", async ({ auth }) => getTelegramSettings(auth.organisationId));
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => {
  const b = await body(req, TelegramSettingsInput);
  if (b.botToken !== undefined) requireElevation(auth);
  return updateTelegramSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, b);
});
