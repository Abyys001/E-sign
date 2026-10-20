"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Mic, MicOff, Phone, PhoneOff, Volume2 } from "lucide-react";
import { useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { cn } from "@/components/ui/cn";
import { api, errMsg } from "@/lib/api";

type Line = { id: string; who: "you" | "ai" | "tool"; text: string };
type Status = "idle" | "connecting" | "live" | "ended";
type Session = { clientSecret: string; voiceProvider: "elevenlabs" | "openai"; greeting: string; maxMinutes: number; allowInterrupt: boolean };
type Conn = { pc: RTCPeerConnection; dc: RTCDataChannel; stream: MediaStream; s: Session; limit: ReturnType<typeof setTimeout> };
type RtEvent = { type: string; item_id?: string; response_id?: string; transcript?: string; text?: string; delta?: string; error?: { message?: string }; response?: { id?: string; output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }> } };

const STEP: Record<string, string> = { financial_position: "cash & liabilities", sales_summary: "sales", profit_and_loss: "profit and loss", compare_periods: "period comparison", events_breakdown: "events", organiser_settlements: "organiser balances", organiser_payments: "organiser payments", performance_series: "monthly figures", expenses: "expenses", stripe_fees: "Stripe fees", reconciliation_status: "reconciliation", unreconciled_transactions: "unreconciled transactions", cash_forecast: "cash forecast", calculate: "calculation" };
/** End of a sentence worth voicing on its own (Latin and Persian punctuation). */
const SENTENCE = /^([\s\S]*?[.!?؟…](?:["')\]]*)\s+|[\s\S]*?\n+)/;

/**
 * Live voice call with the AI Accountant. Mic audio goes to OpenAI over WebRTC (short-lived secret from our server);
 * the model's lookups come back here and run through /api/accounting/ai/call/tool under the user's own session.
 * With ElevenLabs the model answers in text and each sentence is voiced through /api/accounting/ai/call/speak.
 */
export function AccountantCall() {
  const t = useTranslations("accounting.aicall");
  const { q, mode } = useMode();
  const [status, setStatus] = useState<Status>("idle");
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const conn = useRef<Conn | null>(null);
  const audio = useRef<HTMLAudioElement>(null); // OpenAI's own voice (WebRTC track)
  const log = useRef<HTMLDivElement>(null);
  const userMuted = useRef(false);
  // ElevenLabs playback: sentences are fetched as soon as they arrive and played in order.
  const tts = useRef<{ queue: Array<Promise<string | null>>; playing: HTMLAudioElement | null; buf: string; gen: number }>({ queue: [], playing: null, buf: "", gen: 0 });

  const add = (l: Line) => setLines((xs) => (xs.some((x) => x.id === l.id) ? xs.map((x) => (x.id === l.id ? l : x)) : [...xs, l]));
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lines]);
  useEffect(() => { if (status !== "live") return; const i = setInterval(() => setSecs((s) => s + 1), 1000); return () => clearInterval(i); }, [status]);
  useEffect(() => () => hangUp(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function send(ev: unknown) { const dc = conn.current?.dc; if (dc?.readyState === "open") dc.send(JSON.stringify(ev)); }
  /** Mic is live unless the user muted it, or the AI is talking and interrupting is off (it would hear itself). */
  function micLive(aiTalking: boolean) {
    const c = conn.current; if (!c) return;
    const on = !userMuted.current && !(aiTalking && !c.s.allowInterrupt);
    c.stream.getAudioTracks().forEach((tr) => { tr.enabled = on; });
  }

  // ---------- ElevenLabs voice ----------
  function say(text: string) {
    const clean = text.replace(/[*_#`>|]/g, "").trim();
    if (!clean) return;
    const gen = tts.current.gen;
    tts.current.queue.push(fetch(q("/api/accounting/ai/call/speak"), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ text: clean.slice(0, 2000) }) })
      .then(async (r) => { if (!r.ok) { const b = await r.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(b?.error?.message ?? t("voiceFailed")); } return URL.createObjectURL(await r.blob()); })
      .catch((e) => { if (gen === tts.current.gen) setErr(errMsg(e)); return null; }));
    if (!tts.current.playing) void playNext();
  }
  async function playNext() {
    const s = tts.current, gen = s.gen;
    const next = s.queue.shift();
    if (!next) { s.playing = null; setSpeaking(false); micLive(false); return; }
    setSpeaking(true); micLive(true);
    const url = await next;
    if (gen !== s.gen) return; // interrupted while fetching
    if (!url) { void playNext(); return; }
    const el = new Audio(url); s.playing = el;
    el.onended = el.onerror = () => { URL.revokeObjectURL(url); if (gen === s.gen) void playNext(); };
    await el.play().catch(() => { URL.revokeObjectURL(url); if (gen === s.gen) void playNext(); });
  }
  function stopSpeaking() {
    const s = tts.current; s.gen++; s.queue = []; s.buf = "";
    if (s.playing) { s.playing.pause(); s.playing = null; }
    setSpeaking(false); micLive(false);
  }
  function feed(delta: string) {
    const s = tts.current; s.buf += delta;
    for (let m = SENTENCE.exec(s.buf); m; m = SENTENCE.exec(s.buf)) { say(m[1]!); s.buf = s.buf.slice(m[1]!.length); }
  }

  // ---------- realtime events ----------
  async function runTools(calls: Array<{ call_id?: string; name?: string; arguments?: string }>) {
    for (const c of calls) {
      if (!c.call_id || !c.name) continue;
      setBusy(STEP[c.name] ?? c.name);
      add({ id: `tool-${c.call_id}`, who: "tool", text: t("lookingUp", { what: STEP[c.name] ?? c.name }) });
      let output: string;
      try { output = (await api<{ output: string }>(q("/api/accounting/ai/call/tool"), { json: { name: c.name, arguments: c.arguments ?? "{}" } })).output; }
      catch (e) { output = JSON.stringify({ error: errMsg(e) }); }
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output } });
    }
    setBusy(null);
    send({ type: "response.create" });
  }

  function onEvent(ev: RtEvent) {
    const eleven = conn.current?.s.voiceProvider === "elevenlabs";
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        if (eleven && tts.current.playing && conn.current?.s.allowInterrupt) { stopSpeaking(); send({ type: "response.cancel" }); }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript?.trim()) add({ id: `u-${ev.item_id}`, who: "you", text: ev.transcript.trim() });
        break;
      case "response.output_text.delta": case "response.text.delta":
        if (eleven && ev.delta) feed(ev.delta);
        break;
      case "response.output_text.done": case "response.text.done":
        if (eleven) { const rest = tts.current.buf; tts.current.buf = ""; say(rest); }
        if (ev.text?.trim()) add({ id: `a-${ev.item_id}`, who: "ai", text: ev.text.trim() });
        break;
      case "response.output_audio_transcript.done": case "response.audio_transcript.done":
        if (ev.transcript?.trim()) add({ id: `a-${ev.item_id}`, who: "ai", text: ev.transcript.trim() });
        break;
      case "response.done": {
        const calls = (ev.response?.output ?? []).filter((o) => o.type === "function_call");
        if (calls.length) void runTools(calls);
        break;
      }
      case "error":
        if (!/cancel/i.test(ev.error?.message ?? "")) setErr(ev.error?.message ?? t("failed")); // cancelling a finished response is harmless
        break;
    }
  }

  async function call() {
    setErr(null); setLines([]); setSecs(0); setStatus("connecting"); userMuted.current = false; setMuted(false);
    let stream: MediaStream | null = null, pc: RTCPeerConnection | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error(t("unsupported"));
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch { throw new Error(t("micDenied")); }
      const s = await api<Session>(q("/api/accounting/ai/call/session"), { method: "POST" });
      pc = new RTCPeerConnection();
      pc.ontrack = (e) => { if (audio.current) { audio.current.srcObject = e.streams[0]!; void audio.current.play().catch(() => {}); } };
      stream.getTracks().forEach((tr) => pc!.addTrack(tr, stream!));
      const dc = pc.createDataChannel("oai-events");
      dc.onmessage = (m) => { try { onEvent(JSON.parse(m.data as string)); } catch { /* ignore malformed */ } };
      dc.onopen = () => {
        setStatus("live");
        if (s.voiceProvider === "elevenlabs") {
          // Speak the greeting ourselves and tell the model it was said, so it does not greet again.
          send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: s.greeting }] } });
          add({ id: "greeting", who: "ai", text: s.greeting }); say(s.greeting);
        } else send({ type: "response.create", response: { instructions: `Greet the caller with exactly: "${s.greeting.replace(/"/g, "'")}"` } });
      };
      pc.onconnectionstatechange = () => { if (pc && ["failed", "closed"].includes(pc.connectionState)) { if (pc.connectionState === "failed") setErr(t("dropped")); hangUp(); } };
      const limit = setTimeout(() => { setErr(t("timeLimit", { n: s.maxMinutes })); hangUp(); }, s.maxMinutes * 60_000);
      conn.current = { pc, dc, stream, s, limit };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: offer.sdp, headers: { authorization: `Bearer ${s.clientSecret}`, "content-type": "application/sdp" } });
      if (!res.ok) throw new Error(`${t("failed")} (OpenAI ${res.status}: ${(await res.text()).slice(0, 200)})`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (e) {
      setErr(errMsg(e));
      if (conn.current) hangUp(); else { stream?.getTracks().forEach((tr) => tr.stop()); pc?.close(); setStatus("idle"); }
    }
  }

  function hangUp() {
    const c = conn.current; conn.current = null;
    if (!c) return;
    clearTimeout(c.limit);
    stopSpeaking();
    try { c.dc.close(); } catch { /* already closed */ }
    c.stream.getTracks().forEach((tr) => tr.stop());
    c.pc.close();
    setBusy(null); setMuted(false); setStatus("ended");
  }

  function toggleMute() {
    if (!conn.current) return;
    userMuted.current = !userMuted.current; setMuted(userMuted.current); micLive(speaking);
  }

  const live = status === "live", connecting = status === "connecting";
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const label = connecting ? t("connecting") : live ? (busy ? t("lookingUp", { what: busy }) : speaking ? t("speaking") : muted ? t("muted") : t("listening")) : status === "ended" ? t("ended") : t("ready");
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-8 text-center">
        <div className={cn("flex size-24 items-center justify-center rounded-full transition", live ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted", live && !muted && "animate-pulse")}>
          {connecting ? <Loader2 className="size-10 animate-spin" aria-hidden /> : live && speaking ? <Volume2 className="size-10" aria-hidden /> : live && muted ? <MicOff className="size-10" aria-hidden /> : <Phone className="size-10" aria-hidden />}
        </div>
        <div aria-live="polite">
          <p className="text-lg font-semibold">{label}</p>
          <p className="text-sm text-muted">{live ? `${clock} · ${t("books", { mode: mode.toUpperCase() })}` : t("hint")}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {live || connecting ? (
            <>
              <Button size="lg" onClick={toggleMute} disabled={!live} aria-pressed={muted}>{muted ? <Mic className="size-5" aria-hidden /> : <MicOff className="size-5" aria-hidden />}{muted ? t("unmute") : t("mute")}</Button>
              {speaking && <Button size="lg" onClick={() => { stopSpeaking(); send({ type: "response.cancel" }); }}>{t("stopTalking")}</Button>}
              <Button size="lg" variant="danger" onClick={hangUp}><PhoneOff className="size-5" aria-hidden />{t("hangUp")}</Button>
            </>
          ) : (
            <Button size="lg" variant="primary" onClick={call}><Phone className="size-5" aria-hidden />{status === "ended" ? t("callAgain") : t("call")}</Button>
          )}
        </div>
      </div>
      {err && <Callout tone="warn" title={t("problem")}>{err}</Callout>}
      {lines.length > 0 && (
        <div ref={log} className="max-h-[50vh] space-y-2 overflow-y-auto rounded-2xl border border-line bg-surface p-4" aria-label={t("transcript")}>
          {lines.map((l) => (
            <div key={l.id} dir="auto" className={cn("text-sm", l.who === "tool" ? "text-xs italic text-muted" : l.who === "you" ? "ms-auto max-w-[85%] rounded-xl bg-surface-2 px-3 py-2" : "me-auto max-w-[85%] rounded-xl border border-line px-3 py-2")}>
              {l.who !== "tool" && <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted">{l.who === "you" ? t("you") : t("ai")}</span>}{l.text}
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted">{t("privacy")}</p>
      <audio ref={audio} autoPlay className="hidden" />
    </div>
  );
}

const csrf = () => document.cookie.split("; ").find((c) => c.startsWith("bes_csrf="))?.slice(9) ?? "";
