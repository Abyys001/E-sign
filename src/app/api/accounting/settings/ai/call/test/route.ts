import { acct } from "@/server/accounting/http";
import { rateLimit } from "@/server/rate-limit";
import { getCallSettings, speakCall } from "@/server/accounting/ai-call";

/** "Test voice": speak the saved greeting (?lang=fa: the Persian one) with the saved ElevenLabs voice. */
export const POST = acct("accounting.admin", async ({ req, auth }) => {
  await rateLimit("aiVoice", auth.user.id);
  const { settings } = await getCallSettings(auth.organisationId);
  const res = await speakCall(auth.organisationId, req.nextUrl.searchParams.get("lang") === "fa" ? settings.greetingFa : settings.greeting, true);
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
