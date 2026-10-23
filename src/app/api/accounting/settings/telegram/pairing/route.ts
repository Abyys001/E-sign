import { acct } from "@/server/accounting/http";
import { requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { createTelegramPairing } from "@/server/accounting/telegram";

/** One-time "/link CODE" for linking the signed-in user's Telegram account (re-authentication required). */
export const POST = acct("accounting.view", async ({ auth, ctx }) => {
  requireElevation(auth);
  await rateLimit("phoneEnrol", auth.user.id);
  return createTelegramPairing({ orgId: auth.organisationId, userId: auth.user.id, ctx });
});
