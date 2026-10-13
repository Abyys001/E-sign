import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { SpeakInput, speakAnswer } from "@/server/accounting/ai-voice";

/** Read an AI Accountant answer aloud: returns MP3 audio. Nothing is stored. */
export const POST = acct("accounting.view", async ({ req, auth, ctx }) => {
  await rateLimit("aiVoice", auth.user.id);
  const audio = await speakAnswer({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, SpeakInput));
  return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
