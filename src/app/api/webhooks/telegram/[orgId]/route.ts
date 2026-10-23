import { open } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { receiveTelegramUpdate, type TgUpdate } from "@/server/accounting/telegram";

/** Telegram Bot API webhook for the finance assistant. Authenticated by the secret_token header set with setWebhook. */
export const POST = open<{ orgId: string }>(async ({ req, params }) => {
  const orgId = uuid(params.orgId, "Organisation");
  await rateLimit("telegramHook", orgId);
  const text = await req.text();
  if (text.length > 200_000) throw new AppError("payload_too_large", "Update too large.");
  let update: TgUpdate;
  try { update = JSON.parse(text) as TgUpdate; } catch { throw new AppError("validation_failed", "Not JSON."); }
  return receiveTelegramUpdate(orgId, req.headers.get("x-telegram-bot-api-secret-token"), update);
});
