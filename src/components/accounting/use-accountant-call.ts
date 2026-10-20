"use client";
import { useEffect, useRef, useState } from "react";
import type { CallCard } from "@/server/accounting/ai-call-display";

export type { CallCard };

/**
 * Live voice call with the AI Accountant — shared by the finance call page and the phone app.
 *
 * Mic audio goes to OpenAI over WebRTC (short-lived secret from our server); the model's lookups come back here and run
 * on our server under the user's own session. With ElevenLabs the model answers in text and each sentence is voiced by
 * our server (the right voice for its language), played strictly one after another.
 *
 * Playback uses one Web Audio context unlocked by the Call tap: iPhones block or stall <audio> elements started later,
 * especially while the microphone is in use. Every sentence also has a watchdog, so a stalled sentence can never keep
 * the microphone paused.
 *
 * One voice at a time: OpenAI's own audio is ignored when ElevenLabs speaks; sentences are queued on a single player;
 * and unless interrupting is allowed the microphone stays paused from the moment the AI starts answering until it has
 * finished speaking (plus a short echo tail), so the AI never hears itself and starts a second answer over the first.
 */
export type CallLine = { id: string; who: "you" | "ai" | "tool"; text: string };
export type CallStatus = "idle" | "connecting" | "live" | "ended";
type Session = { clientSecret: string; voiceProvider: "elevenlabs" | "openai"; greeting: string; maxMinutes: number; allowInterrupt: boolean };
type RtEvent = { type: string; item_id?: string; transcript?: string; text?: string; delta?: string; error?: { message?: string }; response?: { output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }> } };
export type CallEndpoints = {
  /** POST → Session */ session: string;
  /** POST {name, arguments} → {output} */ tool: string;
  /** POST {text} → audio/mpeg */ speak: string;
  headers: () => Record<string, string>;
};
export type CallText = { micLost: string; failed: string; dropped: string; unsupported: string; micDenied: string; voiceFailed: string; timeLimit: (n: number) => string; lookingUp: (what: string) => string };

export const CALL_STEP: Record<string, string> = { financial_position: "cash & liabilities", sales_summary: "sales", profit_and_loss: "profit and loss", compare_periods: "period comparison", events_breakdown: "events", organiser_settlements: "organiser balances", organiser_payments: "organiser payments", performance_series: "monthly figures", expenses: "expenses", stripe_fees: "Stripe fees", reconciliation_status: "reconciliation", unreconciled_transactions: "unreconciled transactions", cash_forecast: "cash forecast", calculate: "calculation" };
/** End of a sentence worth voicing on its own (Latin and Persian punctuation). */
const SENTENCE = /^([\s\S]*?[.!?؟…](?:["')\]»]*)\s+|[\s\S]*?\n+)/;
const ECHO_TAIL_MS = 450;

async function post<T>(url: string, headers: Record<string, string>, json?: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { ...headers, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const data = await res.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}
const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function useAccountantCall(ep: CallEndpoints, tx: CallText) {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<CallLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const [cards, setCards] = useState<CallCard[]>([]); // verified figures of the latest lookups
  const audioEl = useRef<HTMLAudioElement | null>(null); // OpenAI's own voice (WebRTC track)
  const c = useRef<{ pc: RTCPeerConnection; dc: RTCDataChannel; stream: MediaStream; s: Session; limit: ReturnType<typeof setTimeout> } | null>(null);
  const st = useRef({ userMuted: false, responding: false, openaiTalking: false, micTimer: null as ReturnType<typeof setTimeout> | null });
  const tts = useRef({ queue: [] as Array<Promise<ArrayBuffer | null>>, running: false, stop: null as (() => void) | null, buf: "", gen: 0 });
  const actx = useRef<AudioContext | null>(null);
  const epRef = useRef(ep); epRef.current = ep;
  const txRef = useRef(tx); txRef.current = tx;

  const add = (l: CallLine) => setLines((xs) => (xs.some((x) => x.id === l.id) ? xs.map((x) => (x.id === l.id ? l : x)) : [...xs, l]));
  useEffect(() => { if (status !== "live") return; const i = setInterval(() => setSecs((s) => s + 1), 1000); return () => clearInterval(i); }, [status]);
  useEffect(() => () => hangUp(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function send(ev: unknown) { const dc = c.current?.dc; if (dc?.readyState === "open") dc.send(JSON.stringify(ev)); }

  /** Mic on unless muted, or (interrupting off) while the AI is answering or speaking; re-opened after a short tail. */
  function syncMic() {
    const k = c.current; if (!k) return;
    const s = st.current;
    const aiBusy = s.responding || s.openaiTalking || tts.current.running;
    const want = !s.userMuted && (k.s.allowInterrupt || !aiBusy);
    if (s.micTimer) { clearTimeout(s.micTimer); s.micTimer = null; }
    const apply = (on: boolean) => k.stream.getAudioTracks().forEach((tr) => { tr.enabled = on; });
    if (!want) apply(false);
    else if (!k.s.allowInterrupt && !s.userMuted) s.micTimer = setTimeout(() => apply(true), ECHO_TAIL_MS);
    else apply(true);
  }

  // ---------- ElevenLabs voice: one player, strict order ----------
  function say(text: string) {
    const clean = text.replace(/[*_#`>|]/g, "").trim();
    if (!clean) return;
    const q = tts.current, gen = q.gen;
    q.queue.push(fetch(epRef.current.speak, { method: "POST", credentials: "same-origin", headers: { ...epRef.current.headers(), "content-type": "application/json" }, body: JSON.stringify({ text: clean.slice(0, 2000) }) })
      .then(async (r) => { if (!r.ok) { const b = await r.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(b?.error?.message ?? txRef.current.voiceFailed); } return r.arrayBuffer(); })
      .catch((e) => { if (gen === tts.current.gen) setErr(msg(e, txRef.current.voiceFailed)); return null; }));
    if (!q.running) void pump();
  }
  /** Play one MP3 through the shared audio context; resolves when it ends, is stopped, fails, or the watchdog fires. */
  async function play(buf: ArrayBuffer) {
    const ctx = actx.current; if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    let audio: AudioBuffer;
    try { audio = await ctx.decodeAudioData(buf); } catch { return; }
    await new Promise<void>((done) => {
      const src = ctx.createBufferSource(); src.buffer = audio; src.connect(ctx.destination);
      let over = false;
      const end = () => { if (over) return; over = true; clearTimeout(dog); tts.current.stop = null; try { src.disconnect(); } catch { /* gone */ } done(); };
      const dog = setTimeout(end, Math.min(audio.duration * 1000 + 1500, 20_000)); // never wait forever
      tts.current.stop = () => { try { src.stop(); } catch { /* not started */ } end(); };
      src.onended = end;
      try { src.start(); } catch { end(); }
    });
  }
  async function pump() {
    const q = tts.current, gen = q.gen;
    q.running = true; setSpeaking(true); syncMic();
    while (q.queue.length && gen === q.gen) {
      const buf = await q.queue.shift()!;
      if (gen !== q.gen) return;
      if (buf) await play(buf);
    }
    if (gen !== q.gen) return;
    q.running = false; setSpeaking(false); syncMic();
  }
  function stopSpeaking() {
    const q = tts.current; q.gen++; q.queue = []; q.buf = ""; q.stop?.(); q.running = false;
    setSpeaking(false); syncMic();
  }
  function feed(delta: string) {
    const q = tts.current; q.buf += delta;
    for (let m = SENTENCE.exec(q.buf); m; m = SENTENCE.exec(q.buf)) { say(m[1]!); q.buf = q.buf.slice(m[1]!.length); }
  }

  // ---------- realtime events ----------
  async function runTools(calls: Array<{ call_id?: string; name?: string; arguments?: string }>) {
    st.current.responding = true; syncMic(); // the follow-up answer is still coming
    const shown: CallCard[] = [];
    for (const k of calls) {
      if (!k.call_id || !k.name) continue;
      const what = CALL_STEP[k.name] ?? k.name;
      setBusy(what); add({ id: `tool-${k.call_id}`, who: "tool", text: txRef.current.lookingUp(what) });
      let output: string;
      try {
        const r = await post<{ output: string; cards?: CallCard[] }>(epRef.current.tool, epRef.current.headers(), { name: k.name, arguments: k.arguments ?? "{}" });
        output = r.output; shown.push(...(r.cards ?? []));
      }
      catch (e) { output = JSON.stringify({ error: msg(e, "lookup failed") }); }
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: k.call_id, output } });
    }
    if (shown.length) setCards(shown); // a new lookup replaces the previous topic's cards
    setBusy(null);
    send({ type: "response.create" });
  }

  function onEvent(ev: RtEvent) {
    const k = c.current; if (!k) return;
    const eleven = k.s.voiceProvider === "elevenlabs";
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        if (k.s.allowInterrupt && (tts.current.running || st.current.responding)) { stopSpeaking(); send({ type: "response.cancel" }); }
        break;
      case "response.created": st.current.responding = true; syncMic(); break;
      case "output_audio_buffer.started": st.current.openaiTalking = true; syncMic(); break;
      case "output_audio_buffer.stopped": case "output_audio_buffer.cleared": st.current.openaiTalking = false; syncMic(); break;
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
        if (!eleven && ev.transcript?.trim()) add({ id: `a-${ev.item_id}`, who: "ai", text: ev.transcript.trim() });
        break;
      case "response.done": {
        const calls = (ev.response?.output ?? []).filter((o) => o.type === "function_call");
        st.current.responding = false;
        if (calls.length) void runTools(calls); else syncMic();
        break;
      }
      case "error":
        if (!/cancel/i.test(ev.error?.message ?? "")) setErr(ev.error?.message ?? txRef.current.failed); // cancelling a finished response is harmless
        break;
    }
  }

  async function call() {
    // Unlock audio inside the tap itself (before any await): iPhones only allow sound that a gesture started.
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC && (!actx.current || actx.current.state === "closed")) actx.current = new AC();
      void actx.current?.resume().catch(() => {});
    } catch { /* no Web Audio: ElevenLabs voice stays silent, the call still works */ }
    setErr(null); setLines([]); setCards([]); setSecs(0); setStatus("connecting"); setMuted(false);
    st.current = { userMuted: false, responding: false, openaiTalking: false, micTimer: null };
    let stream: MediaStream | null = null, pc: RTCPeerConnection | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error(txRef.current.unsupported);
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch { throw new Error(txRef.current.micDenied); }
      const s = await post<Session>(epRef.current.session, epRef.current.headers());
      pc = new RTCPeerConnection();
      // With ElevenLabs the AI's voice is ours alone: never play OpenAI's audio track as well.
      pc.ontrack = (e) => { if (s.voiceProvider !== "elevenlabs" && audioEl.current) { audioEl.current.srcObject = e.streams[0]!; void audioEl.current.play().catch(() => {}); } };
      stream.getTracks().forEach((tr) => { pc!.addTrack(tr, stream!); tr.onended = () => { if (c.current) setErr(txRef.current.micLost); }; });
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
      pc.onconnectionstatechange = () => { if (pc && ["failed", "closed"].includes(pc.connectionState)) { if (pc.connectionState === "failed") setErr(txRef.current.dropped); hangUp(); } };
      const limit = setTimeout(() => { setErr(txRef.current.timeLimit(s.maxMinutes)); hangUp(); }, s.maxMinutes * 60_000);
      c.current = { pc, dc, stream, s, limit };
      syncMic();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: offer.sdp, headers: { authorization: `Bearer ${s.clientSecret}`, "content-type": "application/sdp" } });
      if (!res.ok) throw new Error(`${txRef.current.failed} (OpenAI ${res.status}: ${(await res.text()).slice(0, 200)})`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (e) {
      setErr(msg(e, txRef.current.failed));
      if (c.current) hangUp(); else { stream?.getTracks().forEach((tr) => tr.stop()); pc?.close(); setStatus("idle"); }
    }
  }

  function hangUp() {
    const k = c.current; c.current = null;
    if (!k) return;
    clearTimeout(k.limit);
    if (st.current.micTimer) clearTimeout(st.current.micTimer);
    stopSpeaking();
    try { k.dc.close(); } catch { /* already closed */ }
    k.stream.getTracks().forEach((tr) => tr.stop());
    k.pc.close();
    setBusy(null); setMuted(false); setStatus("ended");
  }

  function toggleMute() {
    if (!c.current) return;
    st.current.userMuted = !st.current.userMuted; setMuted(st.current.userMuted); syncMic();
  }
  function interrupt() { stopSpeaking(); send({ type: "response.cancel" }); }

  return { status, muted, speaking, err, lines, cards, busy, secs, audioEl, call, hangUp, toggleMute, interrupt, clearError: () => setErr(null) };
}
