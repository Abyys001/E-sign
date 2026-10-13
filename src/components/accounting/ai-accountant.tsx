"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bot, Check, ChevronDown, Copy, Loader2, Maximize2, Mic, Minimize2, Pause, Play, RotateCcw, Send, Sparkles, Square, Volume2, VolumeX, X } from "lucide-react";
import { Answer } from "@/components/accounting/ai-chat";
import { useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { api, ApiError, errMsg, useApi } from "@/lib/api";
import { detectLanguage } from "@/lib/lang";

/**
 * Bilit AI Accountant — floating assistant on the Financial Overview page.
 * Read-only answers from the server's calculation services, with the evidence behind each answer, Persian/English
 * (RTL/LTR), voice questions (speech-to-text, editable before sending) and spoken answers. The conversation lives only in
 * this tab's session storage; recordings are sent once for transcription and never kept.
 */
type Lang = "en" | "fa";
type Evidence = { id: string; tool: string; title: string; period: { from: string | null; to: string | null } | null; calculatedAt: string; method: string; sources: string[]; records?: number; limitations?: string[] };
type Freshness = { stripe: { connected: boolean; lastSyncAt: string | null; lastWebhookAt: string | null }; wise: { connected: boolean; lastSyncAt: string | null } };
type Msg = { role: "user" | "assistant"; content: string; lang: Lang; error?: boolean; steps?: string[]; evidence?: Evidence[]; freshness?: Freshness; asOf?: string };
type Settings = { enabled: boolean; hasKey: boolean; voiceReady: boolean; voice: { autoSpeak: boolean; maxSeconds: number }; assistant: { defaultLanguage: "auto" | Lang } };
export type AccountantContext = { from?: string | null; to?: string | null; currency?: string | null };
type Focus = { label: string; value?: string | null };

const KEY = "bilit.finance.aiaccountant";
const PREF = "bilit.finance.aiaccountant.prefs";
const read = <T,>(k: string, store: "session" | "local", d: T): T => { try { const v = (store === "session" ? sessionStorage : localStorage).getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, store: "session" | "local", v: unknown) => { try { (store === "session" ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { /* storage may be unavailable */ } };

/** Ask the accountant from anywhere on the page (e.g. a metric card). */
export function askAccountant(focus: Focus) { window.dispatchEvent(new CustomEvent("bilit:ask-accountant", { detail: focus })); }

const SUGGESTIONS = ["profit", "balance", "events", "fees", "settlements", "expenses", "recon", "compare"] as const;

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}
const csrf = () => document.cookie.split("; ").find((c) => c.startsWith("bes_csrf="))?.slice(9) ?? "";

export function AccountantWidget({ context }: { context: AccountantContext }) {
  const t = useTranslations("accounting.aiacc");
  const { q } = useMode();
  const settings = useApi<Settings>("/api/accounting/settings/ai");
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<{ lang: "auto" | Lang; autoSpeak: boolean | null }>({ lang: "auto", autoSpeak: null });
  const [focus, setFocus] = useState<Focus | null>(null);
  const [cite, setCite] = useState<{ msg: number; id: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setMsgs(read<Msg[]>(KEY, "session", [])); setPrefs(read(PREF, "local", { lang: "auto" as const, autoSpeak: null })); setLoaded(true); }, []);
  useEffect(() => { if (loaded) write(KEY, "session", msgs.slice(-40)); end.current?.scrollIntoView({ block: "end" }); }, [msgs, loaded]);
  useEffect(() => { if (loaded) write(PREF, "local", prefs); }, [prefs, loaded]);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [open]);

  const s = settings.data;
  const ready = !!s?.enabled && !!s?.hasKey;
  const autoSpeak = prefs.autoSpeak ?? s?.voice.autoSpeak ?? false;
  const lang: "auto" | Lang = prefs.lang;
  const uiLang: Lang = lang === "auto" ? (s?.assistant.defaultLanguage === "fa" ? "fa" : "en") : lang;

  // ---------- read aloud ----------
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<number, string>());
  const [player, setPlayer] = useState<{ i: number; state: "loading" | "playing" | "paused" } | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const stop = useCallback(() => { audio.current?.pause(); if (audio.current) audio.current.currentTime = 0; setPlayer(null); }, []);
  const speak = useCallback(async (i: number, m: Msg) => {
    setVoiceErr(null);
    if (player?.i === i && audio.current) {
      if (player.state === "playing") { audio.current.pause(); setPlayer({ i, state: "paused" }); return; }
      if (player.state === "paused") { await audio.current.play(); setPlayer({ i, state: "playing" }); return; }
    }
    stop();
    setPlayer({ i, state: "loading" });
    try {
      let url = urls.current.get(i);
      if (!url) {
        const res = await fetch("/api/accounting/ai/voice/speak", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ text: m.content, language: m.lang }) });
        if (!res.ok) { const e = await res.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(e?.error?.message ?? t("voiceFailed")); }
        url = URL.createObjectURL(await res.blob()); urls.current.set(i, url);
      }
      const a = audio.current ?? new Audio(); audio.current = a;
      a.src = url; a.onended = () => setPlayer(null); a.onerror = () => { setPlayer(null); setVoiceErr(t("voiceFailed")); };
      await a.play(); setPlayer({ i, state: "playing" });
    } catch (e) { setPlayer(null); setVoiceErr(errMsg(e)); }
  }, [player, stop, t]);
  useEffect(() => () => { audio.current?.pause(); for (const u of urls.current.values()) URL.revokeObjectURL(u); }, []);

  // ---------- ask ----------
  const ask = useCallback(async (question: string, f: Focus | null = focus, history?: Msg[]) => {
    const qn = question.trim(); if (!qn || busy) return;
    const qLang: Lang = lang === "auto" ? detectLanguage(qn) : lang;
    const base = (history ?? msgs).filter((m) => !m.error);
    const next = [...base, { role: "user" as const, content: qn, lang: qLang }];
    setMsgs(next); setInput(""); setBusy(true); setFocus(null); stop();
    try {
      const r = await api<{ answer: string; language: Lang; steps: string[]; evidence: Evidence[]; freshness: Freshness; asOf: string }>(q("/api/accounting/ai/accountant"), {
        json: { messages: next.slice(-20).map(({ role, content }) => ({ role, content })), language: lang, context: { page: "position", from: context.from ?? null, to: context.to ?? null, currency: context.currency ?? null, focus: f ? { label: f.label, value: f.value ?? null } : null } } });
      const reply: Msg = { role: "assistant", content: r.answer, lang: r.language, steps: r.steps, evidence: r.evidence, freshness: r.freshness, asOf: r.asOf };
      setMsgs([...next, reply]);
      if (autoSpeak && s?.voiceReady) void speak(next.length, reply);
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: e instanceof ApiError && e.status === 429 ? t("rateLimited") : errMsg(e), lang: qLang, error: true }]);
    } finally { setBusy(false); }
  }, [busy, msgs, lang, q, context, focus, autoSpeak, s?.voiceReady, speak, stop, t]);

  const retry = () => { const lastQ = [...msgs].reverse().find((m) => m.role === "user"); if (lastQ) void ask(lastQ.content, null, msgs.slice(0, msgs.lastIndexOf(lastQ))); };

  // A metric card asked about a figure: open, and ask in the chosen language.
  useEffect(() => {
    const h = (e: Event) => {
      const f = (e as CustomEvent<Focus>).detail; setOpen(true);
      const qn = uiLang === "fa" ? t("askAboutFa", { label: f.label, value: f.value ?? "" }) : t("askAbout", { label: f.label, value: f.value ?? "" });
      if (ready) void ask(qn, f); else setInput(qn);
    };
    window.addEventListener("bilit:ask-accountant", h);
    return () => window.removeEventListener("bilit:ask-accountant", h);
  }, [ask, ready, t, uiLang]);

  // ---------- voice in ----------
  const rec = useRef<{ r: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: ReturnType<typeof setInterval> } | null>(null);
  const [recState, setRecState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [secs, setSecs] = useState(0);
  const [heard, setHeard] = useState(false);
  const startRec = async () => {
    setVoiceErr(null); setHeard(false);
    const mime = pickMime();
    if (mime === null || !navigator.mediaDevices?.getUserMedia) { setVoiceErr(t("micUnsupported")); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { setVoiceErr(t("micDenied")); return; }
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = async () => {
      stream.getTracks().forEach((x) => x.stop());
      const blob = new Blob(chunks, { type: r.mimeType || mime || "audio/webm" });
      if (blob.size < 1200) { setRecState("idle"); setVoiceErr(t("tooShort")); return; }
      setRecState("transcribing");
      try {
        const fd = new FormData(); fd.append("audio", blob, "question"); fd.append("language", lang);
        const out = await api<{ text: string; language: Lang }>("/api/accounting/ai/voice/transcribe", { form: fd });
        setInput(out.text); setHeard(true);
        setTimeout(() => box.current?.focus(), 50);
      } catch (e) { setVoiceErr(errMsg(e)); } finally { setRecState("idle"); }
    };
    const max = s?.voice.maxSeconds ?? 90; let n = 0; setSecs(0);
    const timer = setInterval(() => { n++; setSecs(n); if (n >= max) stopRec(); }, 1000);
    rec.current = { r, stream, chunks, timer };
    r.start(); setRecState("recording");
  };
  function stopRec() { const c = rec.current; if (!c) return; clearInterval(c.timer); rec.current = null; if (c.r.state !== "inactive") c.r.stop(); }
  useEffect(() => () => { const c = rec.current; if (c) { clearInterval(c.timer); c.stream.getTracks().forEach((x) => x.stop()); } }, []);

  const copy = async (i: number, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(i); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ } };
  const clear = () => { stop(); for (const u of urls.current.values()) URL.revokeObjectURL(u); urls.current.clear(); setMsgs([]); setCite(null); setInput(""); setHeard(false); };
  const period = context.from || context.to ? `${context.from ?? "…"} – ${context.to ?? t("today")}` : t("allTime");
  const dirOf = (l: Lang) => (l === "fa" ? "rtl" : "ltr");

  return (
    <>
      {open && <div role="dialog" aria-modal="false" aria-label={t("title")} className={cn("fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-2xl",
        "inset-0 sm:inset-auto sm:bottom-20 sm:end-4 sm:rounded-2xl", wide ? "sm:h-[min(820px,calc(100dvh-7rem))] sm:w-[min(760px,calc(100vw-2rem))]" : "sm:h-[min(680px,calc(100dvh-7rem))] sm:w-[min(440px,calc(100vw-2rem))]")}>
        {/* header */}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-[var(--color-12)] px-3 py-2.5 text-[var(--color-1)]">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold"><Bot className="size-4 shrink-0" aria-hidden /><span className="truncate">{t("title")}</span></span>
          <span className="flex items-center gap-0.5">
            <select aria-label={t("language")} value={lang} onChange={(e) => setPrefs({ ...prefs, lang: e.target.value as "auto" | Lang })} className="h-8 rounded-lg border border-white/20 bg-transparent px-1.5 text-xs text-[var(--color-1)] [&>option]:text-fg">
              <option value="auto">{t("langAuto")}</option><option value="en">English</option><option value="fa">فارسی</option>
            </select>
            {s?.voiceReady && <button type="button" onClick={() => setPrefs({ ...prefs, autoSpeak: !autoSpeak })} aria-pressed={autoSpeak} aria-label={autoSpeak ? t("autoSpeakOff") : t("autoSpeakOn")} title={autoSpeak ? t("autoSpeakOff") : t("autoSpeakOn")} className="grid size-8 place-items-center rounded-lg hover:bg-white/10">{autoSpeak ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}</button>}
            {msgs.length > 0 && <button type="button" onClick={clear} aria-label={t("newChat")} title={t("newChat")} className="grid size-8 place-items-center rounded-lg hover:bg-white/10"><RotateCcw className="size-4" /></button>}
            <button type="button" onClick={() => setWide(!wide)} aria-label={wide ? t("shrink") : t("expand")} title={wide ? t("shrink") : t("expand")} className="hidden size-8 place-items-center rounded-lg hover:bg-white/10 sm:grid">{wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("close")} className="grid size-8 place-items-center rounded-lg hover:bg-white/10"><X className="size-4" /></button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line bg-surface-2 px-3 py-1.5 text-[11px] text-muted">
          <span>{t("context", { period, currency: context.currency ? context.currency.toUpperCase() : t("allCurrencies") })}</span>
          {focus && <span className="rounded-full bg-accent-soft px-2 text-accent">{focus.label}</span>}
        </div>

        {settings.loading && !s ? <div className="grid flex-1 place-items-center"><Loader2 className="size-5 animate-spin text-muted" aria-hidden /></div>
          : !ready ? <div className="space-y-2 p-4 text-sm"><p className="font-medium">{t("setupTitle")}</p><p className="text-muted">{t("setup")}</p><Link href="/accounting/settings" className="inline-block underline underline-offset-4">{t("openSettings")}</Link></div>
          : <>
          {/* messages */}
          <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm" aria-live="polite">
            {!msgs.length && <div className="space-y-3">
              <p className="text-muted" dir={dirOf(uiLang)}>{uiLang === "fa" ? t("introFa") : t("intro")}</p>
              <div className="flex flex-wrap gap-2" dir={dirOf(uiLang)}>{SUGGESTIONS.map((k) => {
                const label = uiLang === "fa" ? t(`sugFa.${k}`) : t(`sug.${k}`);
                return <button key={k} type="button" onClick={() => void ask(uiLang === "fa" ? t(`askFa.${k}`) : t(`ask.${k}`))} className="rounded-full border border-line-strong px-3 py-1.5 text-start text-xs hover:border-accent hover:bg-accent-soft focus-visible:outline-2"><Sparkles className="me-1 inline size-3" aria-hidden />{label}</button>;
              })}</div>
            </div>}
            {msgs.map((m, i) => <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div dir={dirOf(m.lang)} lang={m.lang} className={cn("max-w-[94%] rounded-2xl px-3.5 py-2.5", m.role === "user" ? "bg-fg text-bg" : m.error ? "border border-fin-neg/40 bg-fin-neg/10" : "bg-surface-2")}>
                {m.steps && m.steps.length > 0 && <p className="mb-1.5 text-[11px] text-muted">{t("checked", { what: m.steps.join(", ") })}</p>}
                {m.role === "assistant" && !m.error ? <Answer text={m.content} onCite={(id) => setCite(cite?.msg === i && cite.id === id ? null : { msg: i, id })} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
                {m.role === "assistant" && m.error && <Button size="sm" variant="ghost" className="mt-2" onClick={retry}><RotateCcw className="size-3.5" aria-hidden />{t("retry")}</Button>}
                {m.role === "assistant" && !m.error && <>
                  <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-1.5" dir="ltr">
                    {s?.voiceReady && <>
                      <button type="button" onClick={() => void speak(i, m)} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs hover:bg-surface" aria-label={player?.i === i && player.state === "playing" ? t("pause") : player?.i === i && player.state === "paused" ? t("resume") : t("listen")}>
                        {player?.i === i && player.state === "loading" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : player?.i === i && player.state === "playing" ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                        {player?.i === i && player.state === "playing" ? t("pause") : player?.i === i && player.state === "paused" ? t("resume") : t("listen")}</button>
                      {player?.i === i && player.state !== "loading" && <button type="button" onClick={stop} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs hover:bg-surface"><Square className="size-3" aria-hidden />{t("stop")}</button>}
                    </>}
                    <button type="button" onClick={() => void copy(i, m.content)} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs hover:bg-surface">{copied === i ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}{copied === i ? t("copied") : t("copy")}</button>
                    {m.asOf && <span className="ms-auto text-[10px] text-muted">{t("asOf", { at: new Date(m.asOf).toLocaleString() })}</span>}
                  </div>
                  {!!m.evidence?.length && <details className="mt-1.5 rounded-lg border border-line bg-surface text-xs" dir="ltr" open={cite?.msg === i}>
                    <summary className="flex cursor-pointer list-none items-center gap-1 px-2 py-1.5 font-medium"><ChevronDown className="size-3.5" aria-hidden />{t("howCalculated", { n: m.evidence.length })}</summary>
                    <ul className="space-y-2 border-t border-line p-2">
                      {m.evidence.map((e) => <li key={e.id} id={`ev-${i}-${e.id}`} className={cn("rounded-md p-1.5", cite?.msg === i && cite.id === e.id && "bg-accent-soft")}>
                        <p className="font-semibold">{e.id} · {e.title}{e.period ? ` · ${e.period.from ?? t("start")} – ${e.period.to ?? t("today")}` : ""}</p>
                        <p className="text-muted">{e.method}</p>
                        <p className="mt-0.5"><span className="text-muted">{t("sources")}:</span> {e.sources.join("; ")}{e.records != null ? ` · ${t("records", { n: e.records })}` : ""}</p>
                        {!!e.limitations?.length && <p className="mt-0.5 text-fin-warn">{t("limits")}: {e.limitations.join("; ")}</p>}
                        <p className="text-[10px] text-muted">{t("calculatedAt", { at: new Date(e.calculatedAt).toLocaleString() })}</p>
                      </li>)}
                      {m.freshness && <li className="text-[11px] text-muted">{t("freshness", { stripe: m.freshness.stripe.connected ? (m.freshness.stripe.lastSyncAt ? new Date(m.freshness.stripe.lastSyncAt).toLocaleString() : t("never")) : t("notConnected"), wise: m.freshness.wise.connected ? (m.freshness.wise.lastSyncAt ? new Date(m.freshness.wise.lastSyncAt).toLocaleString() : t("never")) : t("notConnected") })}</li>}
                    </ul>
                  </details>}
                </>}
              </div>
            </div>)}
            {busy && <div className="flex items-center gap-2 text-muted" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{uiLang === "fa" ? t("thinkingFa") : t("thinking")}</div>}
            <div ref={end} />
          </div>

          {/* composer */}
          {(voiceErr || heard || recState !== "idle") && <div className={cn("flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs", voiceErr ? "bg-fin-neg/10" : "bg-surface-2")} role="status">
            {recState === "recording" ? <><span className="size-2.5 animate-pulse rounded-full bg-fin-neg" aria-hidden /><span>{t("recording", { s: secs })}</span></>
              : recState === "transcribing" ? <><Loader2 className="size-3.5 animate-spin" aria-hidden />{t("transcribing")}</>
              : voiceErr ? <span>{voiceErr}</span> : <span>{t("heard")}</span>}
          </div>}
          <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
            {s?.voiceReady ? <Button type="button" size="icon" variant={recState === "recording" ? "primary" : "ghost"} disabled={busy || recState === "transcribing"} onClick={() => (recState === "recording" ? stopRec() : void startRec())}
              aria-label={recState === "recording" ? t("stopRecording") : t("speak")} title={recState === "recording" ? t("stopRecording") : t("speak")} className={cn(recState === "recording" && "animate-pulse")}>
              {recState === "recording" ? <Square className="size-4" /> : <Mic className="size-4" />}</Button>
              : <Link href="/accounting/settings" title={t("voiceOff")} className="grid size-10 place-items-center rounded-lg text-muted/60 hover:bg-surface-2 hover:text-fg"><Mic className="size-4" aria-hidden /><span className="sr-only">{t("voiceOff")}</span></Link>}
            <textarea ref={box} value={input} dir="auto" onChange={(e) => { setInput(e.target.value); setHeard(false); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} rows={1}
              placeholder={uiLang === "fa" ? t("placeholderFa") : t("placeholder")} aria-label={t("placeholder")} className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
            <Button type="submit" variant="primary" size="icon" aria-label={t("send")} disabled={busy || !input.trim()}><Send className="size-4 rtl:-scale-x-100" /></Button>
          </form>
          <p className="px-3 pb-2 text-[11px] text-muted">{t("disclaimer")}</p>
        </>}
      </div>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("title")}
        className={cn("fixed bottom-4 end-4 z-50 flex h-14 items-center gap-2 rounded-full bg-accent px-4 text-accent-fg shadow-2xl transition hover:scale-105", open && "max-sm:hidden")}>
        {open ? <X className="size-6" aria-hidden /> : <Bot className="size-6" aria-hidden />}<span className="hidden text-sm font-semibold sm:inline">{open ? t("close") : t("short")}</span>
      </button>
    </>
  );
}
