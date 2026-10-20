"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Phone, Play, RefreshCw } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";

const OPENAI_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
const ELEVEN_MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_v3"] as const;
type Settings = { enabled: boolean; voiceProvider: "elevenlabs" | "openai"; realtimeModel: string; openaiVoice: string; elevenVoiceId: string; elevenVoiceName: string; elevenModel: string; elevenVoiceIdFa: string; elevenVoiceNameFa: string; elevenModelFa: string; startLanguage: "en" | "fa"; greetingFa: string; stability: number; similarity: number; speed: number; greeting: string; callPrompt: string; maxMinutes: number; allowInterrupt: boolean };
type Data = { settings: Settings; defaultPrompt: string; hasElevenKey: boolean; elevenKeyHint: string | null; openAiReady: boolean };
type Voice = { id: string; name: string; category: string | null; labels: string };

/** Finance settings → AI accountant voice call: OpenAI listens and thinks, ElevenLabs (or OpenAI) speaks. */
export function CallSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.aicall.settings");
  const toast = useToast();
  const ensure = useElevation();
  const { data, reload } = useApi<Data>("/api/accounting/settings/ai/call");
  const [v, setV] = useState<(Settings & { elevenApiKey: string }) | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [busy, setBusy] = useState<"save" | "voices" | "test" | "testFa" | null>(null);
  const [err, setErr] = useState<string | null>(null); const [errs, setErrs] = useState<Record<string, string>>({});
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { if (data && !v) setV({ ...data.settings, callPrompt: data.settings.callPrompt || data.defaultPrompt, elevenApiKey: "" }); }, [data, v]);
  if (!v || !data) return <Skeleton className="h-40" />;
  const set = (p: Partial<typeof v>) => setV({ ...v, ...p });

  const fail = (e: unknown) => {
    setErr(errMsg(e));
    if (e instanceof ApiError && Array.isArray(e.details)) setErrs(Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])));
  };
  const save = async (removeKey = false) => {
    setBusy("save"); setErr(null); setErrs({});
    try {
      const sendKey = removeKey || !!v.elevenApiKey;
      if (sendKey && !(await ensure())) return;
      const { elevenApiKey, ...rest } = v;
      // The default prompt is saved as "" so later improvements to the default reach this organisation.
      const json = { ...rest, callPrompt: rest.callPrompt.trim() === data.defaultPrompt.trim() ? "" : rest.callPrompt, ...(removeKey ? { elevenApiKey: null, enabled: rest.voiceProvider === "elevenlabs" ? false : rest.enabled } : elevenApiKey ? { elevenApiKey } : {}) };
      await api("/api/accounting/settings/ai/call", { method: "PATCH", json });
      setV(null); toast("ok", t("saved")); await reload();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const loadVoices = async () => {
    setBusy("voices"); setErr(null);
    try { setVoices((await api<{ voices: Voice[] }>("/api/accounting/settings/ai/call/voices")).voices); }
    catch (e) { fail(e); } finally { setBusy(null); }
  };
  const test = async (lang: "en" | "fa") => {
    setBusy(lang === "fa" ? "testFa" : "test"); setErr(null);
    try {
      const res = await fetch(`/api/accounting/settings/ai/call/test${lang === "fa" ? "?lang=fa" : ""}`, { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": document.cookie.split("; ").find((c) => c.startsWith("bes_csrf="))?.slice(9) ?? "" } });
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(b?.error?.message ?? t("testFailed")); }
      const url = URL.createObjectURL(await res.blob());
      player.current?.pause(); player.current = new Audio(url); player.current.onended = () => URL.revokeObjectURL(url); await player.current.play();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const eleven = v.voiceProvider === "elevenlabs";
  return (
    <Card id="call" className="scroll-mt-24"><CardHeader title={<span className="flex items-center gap-2"><Phone className="size-5" aria-hidden />{t("title")}</span>} description={t("desc")} />
      <div className="space-y-4 p-5">
        {!data.openAiReady && <Callout tone="warn">{t("needsOpenAi")}</Callout>}
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" disabled={!admin} checked={v.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span><span className="font-medium">{t("enable")}</span><span className="block text-xs text-muted">{t("enableHelp")}</span></span></label>
        <fieldset className="space-y-3 rounded-xl border border-line p-4" disabled={!admin}>
          <legend className="px-1 text-sm font-semibold">{t("listenTitle")}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("realtimeModel")} hint={t("realtimeModelHint")} error={errs.realtimeModel}>{(p) => <Input {...p} className="font-mono" value={v.realtimeModel} onChange={(e) => set({ realtimeModel: e.target.value })} />}</Field>
            <Field label={t("voiceProvider")} hint={t("voiceProviderHint")}>{(p) => <Select {...p} value={v.voiceProvider} onChange={(e) => set({ voiceProvider: e.target.value as Settings["voiceProvider"] })}><option value="elevenlabs">ElevenLabs</option><option value="openai">{t("openaiVoice")}</option></Select>}</Field>
          </div>
        </fieldset>
        {eleven ? (
          <fieldset className="space-y-3 rounded-xl border border-line p-4" disabled={!admin}>
            <legend className="px-1 text-sm font-semibold">{t("elevenTitle")}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("elevenKey")} error={errs.elevenApiKey} hint={data.hasElevenKey ? t("keySet", { hint: data.elevenKeyHint ?? "" }) : t("elevenKeyHint")}>{(p) => <Input {...p} type="password" autoComplete="off" placeholder={data.hasElevenKey ? "••••••••" : "sk_…"} value={v.elevenApiKey} onChange={(e) => set({ elevenApiKey: e.target.value })} />}</Field>
              <Field label={t("elevenModel")} hint={t("elevenModelHint")} error={errs.elevenModel}>{(p) => <Input {...p} className="font-mono" list="eleven-models" value={v.elevenModel} onChange={(e) => set({ elevenModel: e.target.value })} />}</Field>
              <datalist id="eleven-models">{ELEVEN_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
              <Field label={t("voice")} error={errs.elevenVoiceId} hint={v.elevenVoiceName ? t("voiceCurrent", { name: v.elevenVoiceName }) : t("voiceHint")}>{(p) => voices
                ? <Select {...p} value={v.elevenVoiceId} onChange={(e) => set({ elevenVoiceId: e.target.value, elevenVoiceName: voices.find((x) => x.id === e.target.value)?.name ?? "" })}><option value="">{t("chooseVoice")}</option>{voices.map((x) => <option key={x.id} value={x.id}>{x.name}{x.labels ? ` — ${x.labels}` : ""}</option>)}</Select>
                : <Input {...p} className="font-mono" placeholder={t("voiceIdPh")} value={v.elevenVoiceId} onChange={(e) => set({ elevenVoiceId: e.target.value.trim(), elevenVoiceName: "" })} />}</Field>
              <div className="flex items-end gap-2 pb-0.5">
                <Button size="sm" loading={busy === "voices"} disabled={!data.hasElevenKey} onClick={loadVoices}><RefreshCw className="size-4" aria-hidden />{t("loadVoices")}</Button>
                <Button size="sm" loading={busy === "test"} disabled={!data.hasElevenKey || !data.settings.elevenVoiceId} onClick={() => test("en")}><Play className="size-4" aria-hidden />{t("test")}</Button>
              </div>
              <Field label={t("stability")} hint={t("stabilityHint")} error={errs.stability}>{(p) => <Input {...p} type="number" min={0} max={1} step={0.05} value={v.stability} onChange={(e) => set({ stability: Number(e.target.value) })} />}</Field>
              <Field label={t("similarity")} hint={t("similarityHint")} error={errs.similarity}>{(p) => <Input {...p} type="number" min={0} max={1} step={0.05} value={v.similarity} onChange={(e) => set({ similarity: Number(e.target.value) })} />}</Field>
              <Field label={t("speed")} hint={t("speedHint")} error={errs.speed}>{(p) => <Input {...p} type="number" min={0.7} max={1.2} step={0.05} value={v.speed} onChange={(e) => set({ speed: Number(e.target.value) })} />}</Field>
            </div>
            <div className="space-y-3 rounded-xl border border-line bg-surface-2/40 p-3">
              <p className="text-sm font-semibold">{t("faTitle")}</p>
              <p className="text-xs text-muted">{t("faDesc")}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("voiceFa")} error={errs.elevenVoiceIdFa} hint={v.elevenVoiceNameFa ? t("voiceCurrent", { name: v.elevenVoiceNameFa }) : t("voiceFaHint")}>{(p) => voices
                  ? <Select {...p} value={v.elevenVoiceIdFa} onChange={(e) => set({ elevenVoiceIdFa: e.target.value, elevenVoiceNameFa: voices.find((x) => x.id === e.target.value)?.name ?? "" })}><option value="">{t("sameVoice")}</option>{voices.map((x) => <option key={x.id} value={x.id}>{x.name}{x.labels ? ` — ${x.labels}` : ""}</option>)}</Select>
                  : <Input {...p} className="font-mono" placeholder={t("sameVoice")} value={v.elevenVoiceIdFa} onChange={(e) => set({ elevenVoiceIdFa: e.target.value.trim(), elevenVoiceNameFa: "" })} />}</Field>
                <Field label={t("elevenModelFa")} hint={t("elevenModelFaHint")} error={errs.elevenModelFa}>{(p) => <Input {...p} className="font-mono" list="eleven-models" value={v.elevenModelFa} onChange={(e) => set({ elevenModelFa: e.target.value })} />}</Field>
              </div>
              <Button size="sm" loading={busy === "testFa"} disabled={!data.hasElevenKey || !data.settings.elevenVoiceId} onClick={() => test("fa")}><Play className="size-4" aria-hidden />{t("testFa")}</Button>
            </div>
            {!data.hasElevenKey && <p className="text-xs text-muted">{t("saveKeyFirst")}</p>}
          </fieldset>
        ) : (
          <fieldset className="space-y-3 rounded-xl border border-line p-4" disabled={!admin}>
            <legend className="px-1 text-sm font-semibold">{t("openaiVoice")}</legend>
            <Field label={t("voice")}>{(p) => <Select {...p} value={v.openaiVoice} onChange={(e) => set({ openaiVoice: e.target.value })}>{OPENAI_VOICES.map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
          </fieldset>
        )}
        <fieldset className="space-y-3 rounded-xl border border-line p-4" disabled={!admin}>
          <legend className="px-1 text-sm font-semibold">{t("behaviourTitle")}</legend>
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <Field label={t("startLanguage")} hint={t("startLanguageHint")}>{(p) => <Select {...p} value={v.startLanguage} onChange={(e) => set({ startLanguage: e.target.value as "en" | "fa" })}><option value="en">English</option><option value="fa">فارسی</option></Select>}</Field>
            <Field label={t("greeting")} hint={t("greetingHint")} error={errs.greeting}>{(p) => <Input {...p} dir="auto" value={v.greeting} onChange={(e) => set({ greeting: e.target.value })} />}</Field>
          </div>
          <Field label={t("greetingFa")} error={errs.greetingFa}>{(p) => <Input {...p} dir="rtl" value={v.greetingFa} onChange={(e) => set({ greetingFa: e.target.value })} />}</Field>
          <Field label={t("prompt")} hint={t("promptHint")} error={errs.callPrompt}>{(p) => <Textarea {...p} dir="auto" className="min-h-64 font-mono text-xs" value={v.callPrompt} onChange={(e) => set({ callPrompt: e.target.value })} />}</Field>
          <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => set({ callPrompt: data.defaultPrompt })}>{t("resetPrompt")}</Button></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("maxMinutes")} error={errs.maxMinutes}>{(p) => <Input {...p} type="number" min={1} max={60} value={v.maxMinutes} onChange={(e) => set({ maxMinutes: Number(e.target.value) })} />}</Field>
            <label className="flex items-start gap-3 self-end pb-2 text-sm"><input type="checkbox" className="mt-1" checked={v.allowInterrupt} onChange={(e) => set({ allowInterrupt: e.target.checked })} /><span><span className="font-medium">{t("interrupt")}</span><span className="block text-xs text-muted">{t("interruptHint")}</span></span></label>
          </div>
        </fieldset>
        <p className="text-xs text-muted">{t("privacy")}</p>
        {err && <Callout tone="warn">{err}</Callout>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {data.settings.enabled && <LinkButton href="/accounting/call" variant="ghost"><Phone className="size-4" aria-hidden />{t("openCall")}</LinkButton>}
          {admin && data.hasElevenKey && <Button variant="ghost" loading={busy === "save"} onClick={() => save(true)}>{t("removeKey")}</Button>}
          {admin && <Button variant="primary" loading={busy === "save"} onClick={() => save()}>{t("save")}</Button>}
        </div>
      </div>
    </Card>
  );
}
