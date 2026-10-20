import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { SpeakCallInput, speakCall } from "@/server/accounting/ai-call";

/** Voice one sentence of the AI's answer during a call (ElevenLabs). Streams MP3; nothing is stored. */
export const POST = acct("accounting.view", async ({ req, auth }) => {
  await rateLimit("aiCallSpeak", auth.user.id);
  const { text } = await body(req, SpeakCallInput);
  const res = await speakCall(auth.organisationId, text);
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
