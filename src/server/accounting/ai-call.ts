import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { stored } from "./ai";
import { DEFAULT_CALL_PROMPT } from "./ai-call-prompt";
import { ACCOUNTANT_TOOL_NAMES, accountantCallSetup, runAccountantTool } from "./ai-accountant";
import { acctAudit, type Mode } from "./core";

/**
 * Live voice call with the Bilit AI Accountant.
 *
 * Listening and thinking: OpenAI Realtime over WebRTC. The browser's microphone goes straight to OpenAI using a
 * short-lived client secret minted here; the long-lived OpenAI key never leaves the server. The model has the same
 * READ-ONLY tools as the chat, and every tool call comes back through /api/accounting/ai/call/tool under the caller's own
 * session, organisation and mode — a call can never see more than the signed-in user could.
 *
 * Speaking: either ElevenLabs text-to-speech (the model answers in text, each sentence is voiced through
 * /api/accounting/ai/call/speak so the ElevenLabs key stays on the server) or OpenAI's own realtime voice.
 *
 * Audio and transcripts are not stored; the audit log records that a call started and which lookups ran.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

const ModelName = z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9._:/-]+$/, "Model names contain only letters, digits and . _ : - /");
/** Voices the OpenAI Realtime API accepts. */
export const REALTIME_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;

export const CallSettings = z.object({
  enabled: z.boolean().default(false),
  voiceProvider: z.enum(["elevenlabs", "openai"]).default("elevenlabs"),
  realtimeModel: ModelName.default("gpt-realtime"),
  openaiVoice: z.enum(REALTIME_VOICES).default("marin"),
  elevenVoiceId: z.string().trim().max(64).regex(/^[A-Za-z0-9]*$/, "A voice ID contains only letters and digits").default(""),
  elevenVoiceName: z.string().trim().max(120).default(""),
  elevenModel: ModelName.default("eleven_flash_v2_5"),
  stability: z.coerce.number().min(0).max(1).default(0.5),
  similarity: z.coerce.number().min(0).max(1).default(0.75),
  speed: z.coerce.number().min(0.7).max(1.2).default(1),
  greeting: z.string().trim().max(300).default("Hi, this is Bilit AI Accountant. What would you like to know about the finances?"),
  callPrompt: z.string().trim().max(30_000).default(""), // empty = DEFAULT_CALL_PROMPT
  maxMinutes: z.coerce.number().int().min(1).max(60).default(15),
  allowInterrupt: z.boolean().default(false), // talking over the AI stops it; needs headphones, or the AI hears itself
});
export type CallSettingsT = z.infer<typeof CallSettings>;
export const CallSettingsInput = CallSettings.extend({
  // Same clean-up as the OpenAI key: pasted keys often carry quotes, spaces or invisible characters.
  elevenApiKey: z.preprocess((v) => (typeof v === "string" ? v.replace(/[\s"'`​-‍﻿]/g, "") : v),
    z.string().min(20, "That does not look like a complete ElevenLabs API key").max(200).regex(/^[A-Za-z0-9_\-]+$/, "The API key contains characters an ElevenLabs key never has").optional().nullable()), // only sent when it changes; null removes it
});

export async function getCallSettings(orgId: string) {
  const s = await stored(orgId);
  return { settings: CallSettings.parse(s.call ?? {}), defaultPrompt: DEFAULT_CALL_PROMPT, hasElevenKey: !!s.elevenKeyEnc, elevenKeyHint: s.elevenKeyHint ?? null, openAiReady: !!s.enabled && !!s.apiKeyEnc };
}

// ---------- ElevenLabs (injectable for tests) ----------
type Eleven = {
  voice: (key: string, voiceId: string) => Promise<{ name: string }>;
  voices: (key: string) => Promise<Array<{ id: string; name: string; category: string | null; labels: string }>>;
  speak: (key: string, a: { voiceId: string; model: string; text: string; stability: number; similarity: number; speed: number }) => Promise<Response>;
};
const g = globalThis as { __eleven?: Eleven };
export const setElevenApi = (e: Eleven | null) => { g.__eleven = e ?? undefined; };

const EL = "https://api.elevenlabs.io";
async function elevenError(res: Response, what: string) {
  const b = await res.json().catch(() => null) as { detail?: { message?: string; status?: string } | string } | null;
  const said = typeof b?.detail === "string" ? b.detail : b?.detail?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) return new AppError("validation_failed", `ElevenLabs did not accept the API key (${said}).`, [{ path: "elevenApiKey", message: "ElevenLabs rejected this key" }]);
  if (res.status === 404) return new AppError("validation_failed", "ElevenLabs has no voice with that ID on this account.", [{ path: "elevenVoiceId", message: "Voice not found" }]);
  return new AppError("invalid_state", `ElevenLabs ${what} failed: ${said}`.slice(0, 400));
}
const elevenApi: Eleven = {
  async voice(key, voiceId) {
    const res = await fetch(`${EL}/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) throw new AppError("invalid_state", "Could not reach ElevenLabs.");
    if (!res.ok) throw await elevenError(res, "voice check");
    const b = await res.json() as { name?: string };
    return { name: b.name ?? voiceId };
  },
  async voices(key) {
    const res = await fetch(`${EL}/v1/voices`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) throw new AppError("invalid_state", "Could not reach ElevenLabs.");
    if (!res.ok) throw await elevenError(res, "voice list");
    const b = await res.json() as { voices?: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string> }> };
    return (b.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category ?? null, labels: Object.values(v.labels ?? {}).join(", ") }));
  },
  async speak(key, { voiceId, model, text, stability, similarity, speed }) {
    const res = await fetch(`${EL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`, {
      method: "POST", signal: AbortSignal.timeout(30_000), headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability, similarity_boost: similarity, speed } }),
    }).catch(() => null);
    if (!res) throw new AppError("invalid_state", "Could not reach ElevenLabs.");
    if (!res.ok || !res.body) throw await elevenError(res, "speech");
    return res;
  },
};
const eleven = () => g.__eleven ?? elevenApi;

export async function updateCallSettings(a: Actor, input: z.infer<typeof CallSettingsInput>) {
  const s = await stored(a.orgId);
  const { elevenApiKey, ...rest } = input;
  const call = CallSettings.parse(rest);
  let keyEnc = s.elevenKeyEnc ?? null, keyHint = s.elevenKeyHint ?? null;
  if (elevenApiKey === null) { keyEnc = null; keyHint = null; }
  else if (elevenApiKey) { keyEnc = encrypt(elevenApiKey); keyHint = `${elevenApiKey.slice(0, 4)}…${elevenApiKey.slice(-4)}`; }
  if (call.enabled && call.voiceProvider === "elevenlabs") {
    if (!keyEnc) throw new AppError("validation_failed", "Add your ElevenLabs API key to use ElevenLabs voices.", [{ path: "elevenApiKey", message: "Paste your ElevenLabs API key" }]);
    if (!call.elevenVoiceId) throw new AppError("validation_failed", "Choose an ElevenLabs voice.", [{ path: "elevenVoiceId", message: "Choose a voice" }]);
  }
  // Check the key + voice with ElevenLabs before saving, so mistakes show up here rather than on the first call.
  if (keyEnc && call.elevenVoiceId) call.elevenVoiceName = (await eleven().voice(decrypt(keyEnc), call.elevenVoiceId)).name;
  if (call.enabled && !(s.enabled && s.apiKeyEnc)) throw new AppError("validation_failed", "Set up the AI accountant (OpenAI key) above first — it does the listening and thinking on calls.");
  const patch = { call, elevenKeyEnc: keyEnc, elevenKeyHint: keyHint };
  await db.transaction(async (tx) => {
    // Merge into the AI settings document so a concurrent save of the AI accountant card is not overwritten.
    await tx.update(schema.acctSettings).set({ aiSettings: sql`coalesce(${schema.acctSettings.aiSettings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: "ai_call_settings.updated", entity: "settings", entityId: "ai_call", old: { call: brief(s.call), elevenKeyHint: s.elevenKeyHint ?? null }, new: { call: brief(call), elevenKeyHint: keyHint, keyChanged: elevenApiKey !== undefined } });
  });
  return getCallSettings(a.orgId);
}

/** Settings for the audit log: the (long) behaviour prompt is logged by length only. */
const brief = (c: Record<string, unknown> | undefined) => (c ? { ...c, callPrompt: typeof c.callPrompt === "string" && c.callPrompt ? `${c.callPrompt.length} chars` : "default" } : null);

export async function listElevenVoices(orgId: string) {
  const s = await stored(orgId);
  if (!s.elevenKeyEnc) throw new AppError("invalid_state", "Save your ElevenLabs API key first.");
  return { voices: await eleven().voices(decrypt(s.elevenKeyEnc)) };
}

async function readyCall(orgId: string) {
  const s = await stored(orgId);
  const call = CallSettings.parse(s.call ?? {});
  if (!call.enabled) throw new AppError("invalid_state", "Voice calls are switched off. An admin can turn them on under Finance settings → AI accountant voice call.");
  return { s, call };
}

// ---------- call ----------
export const CallToolInput = z.object({ name: z.string().refine((n) => ACCOUNTANT_TOOL_NAMES.includes(n), "Unknown tool"), arguments: z.string().max(8000).default("{}") });
export const SpeakCallInput = z.object({ text: z.string().trim().min(1).max(2000) });

export async function startAccountantCall(a: Actor, mode: Mode) {
  const { call } = await readyCall(a.orgId);
  const eleven = call.voiceProvider === "elevenlabs";
  const { cfg, instructions, tools } = await accountantCallSetup(a, mode, call.callPrompt || DEFAULT_CALL_PROMPT);
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 120 }, // only needed to open the call; the call itself can run longer
        session: {
          type: "realtime", model: call.realtimeModel, instructions, tools, tool_choice: "auto", ...(eleven ? { output_modalities: ["text"] } : {}),
          audio: {
            input: { transcription: { model: "gpt-4o-mini-transcribe" }, noise_reduction: { type: "near_field" }, turn_detection: { type: "semantic_vad", interrupt_response: call.allowInterrupt } },
            ...(eleven ? {} : { output: { voice: call.openaiVoice } }),
          },
        },
      }),
    });
  } catch { throw new AppError("invalid_state", "Could not reach OpenAI to start the call. Please try again."); }
  const body = await res.json().catch(() => null) as { value?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.value) throw new AppError("invalid_state", `OpenAI did not start the call (check the key has Realtime access and the model name). OpenAI: ${body?.error?.message ?? `HTTP ${res.status}`}`.replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-…").slice(0, 400));
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_accountant.call_started", entity: "ai_accountant", entityId: "voice_call", new: { mode, model: call.realtimeModel, voice: eleven ? `elevenlabs:${call.elevenVoiceName || call.elevenVoiceId}` : `openai:${call.openaiVoice}` } }));
  return { clientSecret: body.value, voiceProvider: call.voiceProvider, greeting: call.greeting, maxMinutes: call.maxMinutes, allowInterrupt: call.allowInterrupt };
}

export async function callTool(a: Actor, mode: Mode, input: z.infer<typeof CallToolInput>) {
  await readyCall(a.orgId);
  let args: Record<string, unknown> = {};
  try { const v = JSON.parse(input.arguments || "{}"); if (v && typeof v === "object") args = v; } catch { /* bad JSON from the model */ }
  const r = await runAccountantTool(a, mode, input.name, args);
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_accountant.call_lookup", entity: "ai_accountant", entityId: "voice_call", new: { mode, tool: input.name, period: r.evidence[0]?.period ?? null } }));
  return { output: r.output };
}

/** One sentence of the AI's answer, voiced by ElevenLabs. Streams MP3 back; nothing is stored. `test` = the settings
 * page's "Test voice", which works before calls are switched on. */
export async function speakCall(orgId: string, text: string, test = false) {
  const s = await stored(orgId);
  const call = test ? CallSettings.parse(s.call ?? {}) : (await readyCall(orgId)).call;
  if (!s.elevenKeyEnc || !call.elevenVoiceId) throw new AppError("invalid_state", "ElevenLabs is not set up (API key and voice) under Finance settings → AI accountant voice call.");
  return eleven().speak(decrypt(s.elevenKeyEnc), { voiceId: call.elevenVoiceId, model: call.elevenModel, text, stability: call.stability, similarity: call.similarity, speed: call.speed });
}
