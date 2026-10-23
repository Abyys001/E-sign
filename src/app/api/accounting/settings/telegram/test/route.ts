import { acct } from "@/server/accounting/http";
import { rateLimit } from "@/server/rate-limit";
import { testTelegramVoice } from "@/server/accounting/telegram";

/** Send a test voice note (English or ?lang=fa Persian) to the linked Telegram accounts. */
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  await rateLimit("aiVoice", auth.user.id);
  return testTelegramVoice({ orgId: auth.organisationId, userId: auth.user.id, ctx }, req.nextUrl.searchParams.get("lang") === "fa" ? "fa" : "en");
});
