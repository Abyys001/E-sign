import { body, open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { SpeakCallInput, speakCall } from "@/server/accounting/ai-call";
import { requirePhone } from "@/server/accounting/phone";

/** Phone app: voice one sentence of the AI's answer (ElevenLabs). Streams MP3; nothing is stored. */
export const POST = open(async ({ req, ctx }) => {
  const a = await requirePhone(req, ctx);
  await rateLimit("aiCallSpeak", a.userId);
  const { text } = await body(req, SpeakCallInput);
  const res = await speakCall(a.orgId, text);
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
