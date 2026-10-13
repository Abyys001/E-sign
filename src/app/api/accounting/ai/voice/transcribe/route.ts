import { acct } from "@/server/accounting/http";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { MAX_AUDIO_BYTES, transcribeQuestion } from "@/server/accounting/ai-voice";

/** Spoken question → text (multipart field `audio`, optional `language` = auto|en|fa). The recording is not stored. */
export const POST = acct("accounting.view", async ({ req, auth, ctx }) => {
  await rateLimit("aiVoice", auth.user.id);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES + 64 * 1024) throw new AppError("validation_failed", "The recording is too long. Keep questions under about 2 minutes.");
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the recording as multipart/form-data."); });
  const file = form.get("audio");
  if (!(file instanceof File)) throw new AppError("validation_failed", "No recording received.", [{ path: "audio", message: "Required" }]);
  const lang = String(form.get("language") ?? "auto");
  return transcribeQuestion({ orgId: auth.organisationId, userId: auth.user.id, ctx }, file, lang === "en" || lang === "fa" ? lang : "auto");
});
