import { z } from "zod";
import { db } from "@/db";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { aiConfig, type VoiceSettingsT } from "./ai";
import { detectLanguage, type Lang } from "./ai-accountant";
import { acctAudit } from "./core";

/**
 * Voice for the Bilit AI Accountant, through the organisation's OpenAI key (server-side only):
 *  - speech-to-text: the recording is sent to OpenAI and dropped — it is never written to disk, storage or logs;
 *  - text-to-speech: the answer is turned into plain spoken text (no markdown, tables read row by row, negative
 *    amounts read as "minus"/«منفی») and returned as MP3; nothing is kept.
 * The audit log records only that voice was used (length, language, model) — not the words or the audio.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_TYPES = /^(audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|wave|x-m4a|m4a|aac|flac)|video\/webm)(;.*)?$/i;

export const SpeakInput = z.object({ text: z.string().trim().min(1).max(12_000), language: z.enum(["auto", "en", "fa"]).default("auto") });

/** Plain text for reading aloud. Pure; unit-tested. */
export function speechText(markdown: string, lang: Lang, max = 4000): string {
  const minus = lang === "fa" ? "منفی " : "minus ";
  const lines: string[] = [];
  for (const raw of markdown.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(l)) continue; // table separator
    if (l.startsWith("|")) { const cells = l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean); lines.push(`${cells.join(lang === "fa" ? "، " : ", ")}.`); continue; }
    lines.push(l.replace(/^#{1,6}\s+/, "").replace(/^\s*([-*•]|\d+\.)\s+/, ""));
  }
  let s = lines.join("\n")
    .replace(/\[(E\d+)\]/g, "") // evidence markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/[*_`~]+/g, "")
    // −£12.50, -€3, £-12.50, -1,234.56 SEK → "minus …"
    .replace(/(^|[\s(:=،])[-−–]\s?(?=[£€$]|[A-Z]{3}\s?\d|\d)/g, `$1${minus}`)
    .replace(/([£€$])\s?[-−–](?=\d)/g, `${minus}$1`)
    .replace(/\s*→\s*/g, lang === "fa" ? " به " : " to ")
    .replace(/[ \t]+/g, " ").trim();
  if (s.length > max) { const cut = s.slice(0, max); const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"), cut.lastIndexOf("؟"), cut.lastIndexOf("."));
    s = `${cut.slice(0, end > max * 0.6 ? end + 1 : max)} ${lang === "fa" ? "ادامه‌ی پاسخ را روی صفحه ببینید." : "The rest of the answer is on screen."}`; }
  return s;
}

const STT_PROMPT = "Bilit Events finance questions in English or Persian (Farsi). Terms: Stripe, Wise, booking fee, organiser, settlement, payout, refund, net profit, liabilities, cash position, Pegasus, Epic Wave. فروش، سود، سود خالص، کارمزد، کارمزد استرایپ، برگزارکننده، تسویه، بدهی، پرداخت، استرداد، نقدینگی، هزینه‌ها، ایونت، بیلیت.";
const TTS_STYLE: Record<Lang, string> = {
  en: "Calm, clear, professional financial assistant. Read amounts precisely: say the currency, read decimals as pence/cents, read percentages clearly. Moderate pace.",
  fa: "دستیار مالی آرام، شمرده و حرفه‌ای. مبالغ، درصدها و تاریخ‌ها را دقیق و واضح بخوان. Speak natural Persian (Farsi); read English brand names (Stripe, Wise, Bilit) in English.",
};

// ---------- provider (injectable for tests) ----------
export type VoiceApi = {
  transcribe: (a: { apiKey: string; model: string; audio: Blob; fileName: string; language?: Lang; prompt: string; timeoutMs: number }) => Promise<{ text: string; language?: string }>;
  speak: (a: { apiKey: string; model: string; voice: string; text: string; instructions?: string; timeoutMs: number }) => Promise<ArrayBuffer>;
};
const gv = globalThis as { __voiceApi?: VoiceApi };
export const setVoiceApi = (v: VoiceApi | null) => { gv.__voiceApi = v ?? undefined; };

const clean = (s: string) => s.replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-…").slice(0, 300);
async function openAiError(res: Response, what: string) {
  const b = await res.json().catch(() => null) as { error?: { message?: string } } | null;
  const said = clean(b?.error?.message ?? `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) return new AppError("invalid_state", `OpenAI refused the ${what} request — check the key's permissions (audio) in Finance settings → AI accountant. OpenAI: ${said}`);
  if (res.status === 404 || res.status === 400) return new AppError("invalid_state", `OpenAI did not accept the ${what} request — check the voice model names in Finance settings → AI accountant. OpenAI: ${said}`);
  return new AppError("invalid_state", `OpenAI ${what} failed: ${said}`);
}
const openAiVoice: VoiceApi = {
  async transcribe({ apiKey, model, audio, fileName, language, prompt, timeoutMs }) {
    const form = new FormData();
    form.append("file", audio, fileName);
    form.append("model", model);
    form.append("response_format", "json");
    form.append("prompt", prompt);
    if (language) form.append("language", language);
    let res: Response;
    try { res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${apiKey}` }, body: form }); }
    catch { throw new AppError("invalid_state", "Could not reach OpenAI for speech recognition. Try again."); }
    if (!res.ok) throw await openAiError(res, "speech recognition");
    const b = await res.json() as { text?: string; language?: string };
    return { text: b.text ?? "", language: b.language };
  },
  async speak({ apiKey, model, voice, text, instructions, timeoutMs }) {
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, voice, input: text, response_format: "mp3", ...(instructions ? { instructions } : {}) }) });
    } catch { throw new AppError("invalid_state", "Could not reach OpenAI for speech. Try again."); }
    if (!res.ok) throw await openAiError(res, "speech");
    return res.arrayBuffer();
  },
};

async function voiceConfig(orgId: string): Promise<{ apiKey: string; voice: VoiceSettingsT; timeoutMs: number }> {
  const cfg = await aiConfig(orgId);
  if (!cfg.voice.enabled) throw new AppError("invalid_state", "Voice is not switched on. An admin can enable it under Finance settings → AI accountant → Voice.");
  return { apiKey: cfg.apiKey, voice: cfg.voice, timeoutMs: cfg.assistant.timeoutSec * 1000 };
}

export async function transcribeQuestion(a: Actor, file: File, language: "auto" | Lang) {
  if (!file.size) throw new AppError("validation_failed", "The recording is empty — hold the microphone a little longer.");
  if (file.size > MAX_AUDIO_BYTES) throw new AppError("validation_failed", "The recording is too long. Keep questions under about 2 minutes.");
  if (!AUDIO_TYPES.test(file.type || "")) throw new AppError("validation_failed", "Unsupported audio format.");
  const v = await voiceConfig(a.orgId);
  const ext = /ogg/.test(file.type) ? "ogg" : /mp4|m4a|aac/.test(file.type) ? "m4a" : /mpeg|mp3/.test(file.type) ? "mp3" : /wav|wave/.test(file.type) ? "wav" : "webm";
  const out = await (gv.__voiceApi ?? openAiVoice).transcribe({ apiKey: v.apiKey, model: v.voice.sttModel, audio: file, fileName: `question.${ext}`, language: language === "auto" ? undefined : language, prompt: STT_PROMPT, timeoutMs: v.timeoutMs });
  const text = out.text.trim().slice(0, 4000);
  const lang: Lang = language !== "auto" ? language : /^(fa|persian|farsi)$/i.test(out.language ?? "") ? "fa" : detectLanguage(text);
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_accountant.voice_in", entity: "ai_accountant", entityId: "voice", new: { bytes: file.size, chars: text.length, language: lang, model: v.voice.sttModel } }));
  if (!text) throw new AppError("validation_failed", lang === "fa" ? "صدایی تشخیص داده نشد. دوباره امتحان کنید." : "No speech was recognised. Please try again.");
  return { text, language: lang };
}

export async function speakAnswer(a: Actor, input: z.infer<typeof SpeakInput>) {
  const v = await voiceConfig(a.orgId);
  const lang: Lang = input.language === "auto" ? detectLanguage(input.text) : input.language;
  const text = speechText(input.text, lang);
  if (!text) throw new AppError("validation_failed", "Nothing to read aloud.");
  const model = v.voice.ttsModel;
  const audio = await (gv.__voiceApi ?? openAiVoice).speak({ apiKey: v.apiKey, model, voice: lang === "fa" ? v.voice.voiceFa : v.voice.voiceEn, text, instructions: /gpt-4o/.test(model) ? TTS_STYLE[lang] : undefined, timeoutMs: v.timeoutMs });
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_accountant.voice_out", entity: "ai_accountant", entityId: "voice", new: { chars: text.length, language: lang, model } }));
  return audio;
}
