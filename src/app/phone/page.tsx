"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Delete, Lock, Mic, MicOff, Phone, PhoneOff, QrCode, VolumeX } from "lucide-react";
import { useCallText } from "@/components/accounting/ai-call";
import { CallCards } from "@/components/accounting/call-cards";
import { useAccountantCall } from "@/components/accounting/use-accountant-call";
import { cn } from "@/components/ui/cn";

type Status = { enrolled: false } | { enrolled: true; unlocked: boolean; deviceName: string; userName: string; triesLeft: number; idleMinutes: number };
type ApiErr = { error?: { code?: string; message?: string; details?: { code?: string } | Array<{ message: string }> } };
const PHONE = { "x-bilit-phone": "1" };
const csrf = () => document.cookie.split("; ").find((c) => c.startsWith("bes_csrf="))?.slice(9) ?? "";
const BG_LOCK_MS = 2 * 60_000; // backgrounded longer than this → PIN again

async function call<T>(url: string, json?: unknown, headers: Record<string, string> = PHONE): Promise<T> {
  const res = await fetch(url, { method: json === undefined ? "GET" : "POST", credentials: "same-origin", headers: { ...headers, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const b = await res.json().catch(() => null) as (T & ApiErr) | null;
  if (!res.ok) {
    const d = b?.error?.details;
    throw Object.assign(new Error((Array.isArray(d) && d[0]?.message) || b?.error?.message || `Error ${res.status}`), { code: (!Array.isArray(d) && d?.code) || b?.error?.code });
  }
  return b as T;
}

/** Bilit Phone: installable, PIN-locked call screen for the AI Accountant. */
export default function PhoneApp() {
  const t = useTranslations("accounting.phone");
  const [st, setSt] = useState<Status | null>(null);
  const [pair, setPair] = useState<string | null>(null);
  const load = useCallback(async () => { try { setSt(await call<Status>("/api/phone/status")); } catch { setSt({ enrolled: false }); } }, []);

  useEffect(() => {
    const m = /pair=([^&]+)/.exec(window.location.hash);
    if (m) { setPair(decodeURIComponent(m[1]!)); history.replaceState(null, "", "/phone"); } // keep the one-time code out of history
    void load();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/phone/sw.js", { scope: "/phone" }).catch(() => {});
  }, [load]);

  if (!st) return <Screen><div className="m-auto size-10 animate-spin rounded-full border-2 border-white/20 border-t-white" aria-label={t("loading")} /></Screen>;
  if (pair || !st.enrolled) return <Setup pairCode={pair} onDone={() => { setPair(null); void load(); }} />;
  if (!st.unlocked) return <Unlock status={st} onDone={load} onGone={load} />;
  return <CallScreen status={st} onLocked={load} />;
}

function Screen({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn("mx-auto flex min-h-dvh max-w-md flex-col px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]", className)}>{children}</main>;
}
function Avatar({ pulse, small }: { pulse?: boolean; small?: boolean }) {
  return (
    <div className={cn("relative mx-auto grid place-items-center rounded-full bg-gradient-to-br from-[#20ac6a] to-[#0f6b40] shadow-[0_0_60px_rgba(32,172,106,.35)]", small ? "size-20" : "size-32")}>
      {pulse && <span className="absolute inset-0 animate-ping rounded-full bg-[#20ac6a]/30" aria-hidden />}
      <img src="/brand/bilit-mark-512.png" alt="" className={cn("relative rounded-full", small ? "size-12" : "size-20")} />
    </div>
  );
}

// ---------- PIN pad ----------
function PinPad({ value, onChange, onDone, disabled }: { value: string; onChange: (v: string) => void; onDone: (v: string) => void; disabled?: boolean }) {
  const press = (d: string) => { if (disabled || value.length >= 6) return; const v = value + d; onChange(v); if (v.length === 6) onDone(v); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === "Backspace") onChange(value.slice(0, -1)); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });
  return (
    <div className="space-y-8">
      <div className="flex justify-center gap-4" aria-live="polite" aria-label={`${value.length} / 6`}>
        {Array.from({ length: 6 }, (_, i) => <span key={i} className={cn("size-3.5 rounded-full border border-white/60 transition", i < value.length && "scale-110 bg-white")} />)}
      </div>
      <div className="mx-auto grid max-w-72 grid-cols-3 gap-5">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <Key key={d} onClick={() => press(d)} disabled={disabled}>{d}</Key>)}
        <span />
        <Key onClick={() => press("0")} disabled={disabled}>0</Key>
        <button type="button" onClick={() => onChange(value.slice(0, -1))} className="grid size-20 place-items-center rounded-full text-white/80 active:bg-white/10" aria-label="Delete"><Delete className="size-7" /></button>
      </div>
    </div>
  );
}
function Key({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="grid size-20 place-items-center rounded-full bg-white/10 text-3xl font-light transition active:scale-95 active:bg-white/25 disabled:opacity-40">{children}</button>;
}

// ---------- set-up ----------
function Setup({ pairCode, onDone }: { pairCode: string | null; onDone: () => void }) {
  const t = useTranslations("accounting.phone");
  const [signedIn, setSignedIn] = useState<{ name: string; hasTotp: boolean } | null | undefined>(undefined);
  const [step, setStep] = useState<"intro" | "pin" | "confirm">("intro");
  const [pin, setPin] = useState(""); const [first, setFirst] = useState("");
  const [name, setName] = useState(() => (typeof navigator !== "undefined" && /iPhone/.test(navigator.userAgent) ? "iPhone" : /Android/.test(typeof navigator !== "undefined" ? navigator.userAgent : "") ? "Android phone" : "My phone"));
  const [password, setPassword] = useState(""); const [totp, setTotp] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pairCode) return;
    fetch("/api/auth/me", { credentials: "same-origin" }).then(async (r) => {
      if (!r.ok) return setSignedIn(null);
      const b = await r.json() as { user?: { name?: string; hasTotp?: boolean } };
      setSignedIn({ name: b.user?.name ?? "", hasTotp: !!b.user?.hasTotp });
    }).catch(() => setSignedIn(null));
  }, [pairCode]);

  const finish = async (p: string) => {
    if (p !== first) { setErr(t("pinMismatch")); setPin(""); setFirst(""); setStep("pin"); return; }
    setBusy(true); setErr(null);
    try {
      if (pairCode) await call("/api/phone/pair", { code: pairCode, name, pin: p });
      else await call("/api/phone/enrol", { name, pin: p, ...(signedIn?.hasTotp ? { totp } : { password }) }, { "x-csrf-token": csrf() });
      onDone();
    } catch (e) { setErr((e as Error).message); setPin(""); setFirst(""); setStep(pairCode ? "pin" : "intro"); }
    finally { setBusy(false); }
  };

  if (step === "pin" || step === "confirm") return (
    <Screen className="justify-between">
      <div className="space-y-3 pt-8 text-center"><Lock className="mx-auto size-8 text-white/70" aria-hidden /><h1 className="text-xl font-semibold">{step === "pin" ? t("choosePin") : t("confirmPin")}</h1><p className="text-sm text-white/60">{t("pinHelp")}</p>{err && <p role="alert" className="text-sm text-[#ff8a80]">{err}</p>}</div>
      <PinPad value={pin} onChange={setPin} disabled={busy} onDone={(v) => { if (step === "pin") { setFirst(v); setPin(""); setErr(null); setStep("confirm"); } else void finish(v); }} />
      <div />
    </Screen>
  );

  const canStart = pairCode || (signedIn && (signedIn.hasTotp ? totp.length >= 6 : password.length > 0));
  return (
    <Screen className="justify-center gap-8 text-center">
      <Avatar />
      <div className="space-y-2"><h1 className="text-2xl font-semibold">Bilit Phone</h1><p className="text-white/70">{t("setupIntro")}</p></div>
      {err && <p role="alert" className="text-sm text-[#ff8a80]">{err}</p>}
      {pairCode || signedIn ? (
        <div className="space-y-3 text-start">
          <label className="block text-sm text-white/70">{t("phoneName")}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="mt-1 w-full rounded-xl bg-white/10 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-[#20ac6a]" /></label>
          {!pairCode && signedIn && (signedIn.hasTotp
            ? <label className="block text-sm text-white/70">{t("totp")}<input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="mt-1 w-full rounded-xl bg-white/10 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-[#20ac6a]" /></label>
            : <label className="block text-sm text-white/70">{t("password", { name: signedIn.name })}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-xl bg-white/10 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-[#20ac6a]" /></label>)}
          <button type="button" disabled={!canStart || busy} onClick={() => { setErr(null); setStep("pin"); }} className="mt-2 w-full rounded-2xl bg-[#20ac6a] py-4 text-lg font-semibold disabled:opacity-40">{t("continue")}</button>
        </div>
      ) : signedIn === null ? (
        <div className="space-y-4 rounded-2xl bg-white/5 p-5 text-start text-sm text-white/80">
          <p className="flex items-center gap-2 font-semibold text-white"><QrCode className="size-5" aria-hidden />{t("scanTitle")}</p>
          <p>{t("scanHelp")}</p>
          <a href="/login" className="block rounded-xl bg-white/10 py-3 text-center font-medium text-white">{t("signInHere")}</a>
        </div>
      ) : <div className="m-auto size-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />}
    </Screen>
  );
}

// ---------- unlock ----------
function Unlock({ status, onDone, onGone }: { status: Extract<Status, { enrolled: true }>; onDone: () => void; onGone: () => void }) {
  const t = useTranslations("accounting.phone");
  const [pin, setPin] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [shake, setShake] = useState(false);
  const submit = async (p: string) => {
    setBusy(true); setErr(null);
    try { await call("/api/phone/unlock", { pin: p }); onDone(); }
    catch (e) {
      setPin(""); setErr((e as Error).message); setShake(true); setTimeout(() => setShake(false), 400);
      if ((e as { code?: string }).code === "phone_not_enrolled") setTimeout(onGone, 2500);
    } finally { setBusy(false); }
  };
  return (
    <Screen className="justify-between">
      <div className="space-y-3 pt-6 text-center"><Avatar small /><p className="text-sm text-white/60">{status.userName} · {status.deviceName}</p><h1 className="text-xl font-semibold">{t("enterPin")}</h1>
        <p role="alert" className={cn("min-h-5 text-sm text-[#ff8a80] transition", shake && "translate-x-1")}>{err}</p></div>
      <PinPad value={pin} onChange={setPin} onDone={(v) => void submit(v)} disabled={busy} />
      <p className="text-center text-xs text-white/40">{t("lockedHelp")}</p>
    </Screen>
  );
}

// ---------- call ----------
function CallScreen({ status, onLocked }: { status: Extract<Status, { enrolled: true }>; onLocked: () => void }) {
  const t = useTranslations("accounting.phone");
  const ta = useTranslations("accounting.aicall");
  const k = useAccountantCall({ session: "/api/phone/call/session", tool: "/api/phone/call/tool", speak: "/api/phone/call/speak", headers: () => PHONE }, useCallText());
  const live = k.status === "live", connecting = k.status === "connecting", inCall = live || connecting;
  const hidden = useRef<number | null>(null);
  const lock = useCallback(async () => { k.hangUp(); await fetch("/api/phone/lock", { method: "POST", credentials: "same-origin", headers: PHONE }).catch(() => {}); onLocked(); }, [k, onLocked]);

  // Lock when the app was in the background for a while (not during a call), and when the server says it is locked.
  useEffect(() => {
    const v = () => {
      if (document.hidden) { hidden.current = Date.now(); return; }
      if (hidden.current && Date.now() - hidden.current > BG_LOCK_MS && !inCall) void lock();
      hidden.current = null;
    };
    document.addEventListener("visibilitychange", v); return () => document.removeEventListener("visibilitychange", v);
  }, [inCall, lock]);
  useEffect(() => { if (k.err && /locked|PIN|set up/i.test(k.err)) onLocked(); }, [k.err, onLocked]);
  // Keep the screen awake during a call where supported.
  useEffect(() => {
    if (!live || !("wakeLock" in navigator)) return;
    let s: WakeLockSentinel | null = null;
    navigator.wakeLock.request("screen").then((x) => { s = x; }).catch(() => {});
    return () => { void s?.release().catch(() => {}); };
  }, [live]);

  const clock = `${String(Math.floor(k.secs / 60)).padStart(2, "0")}:${String(k.secs % 60).padStart(2, "0")}`;
  const label = connecting ? ta("connecting") : live ? (k.busy ? ta("lookingUp", { what: k.busy }) : k.speaking ? ta("speaking") : k.muted ? ta("muted") : ta("listening")) : k.status === "ended" ? ta("ended") : t("tapToCall");
  const last = k.lines.filter((l) => l.who !== "tool").slice(-3);
  return (
    <Screen className={cn("justify-between transition-colors", inCall && "bg-gradient-to-b from-[#0f2a1d] to-[#0b0f0d]")}>
      <header className="flex items-center justify-between text-sm text-white/60">
        <span>{status.userName}</span>
        {!inCall && <button type="button" onClick={() => void lock()} className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-white/80"><Lock className="size-4" aria-hidden />{t("lock")}</button>}
      </header>
      <section className="space-y-5 text-center">
        <Avatar pulse={live && (k.speaking || !!k.busy)} />
        <div><h1 className="text-2xl font-semibold">Bilit AI Accountant</h1><p className="mt-1 text-white/70" aria-live="polite">{label}</p>{live && <p className="mt-1 font-mono text-lg tabular-nums text-white/80">{clock}</p>}</div>
        {k.err && <p role="alert" className="mx-auto max-w-xs text-sm text-[#ff8a80]">{k.err}</p>}
      </section>
      <CallCards cards={k.cards} dark className="max-h-[38dvh] overflow-y-auto" />
      <section className="min-h-28 space-y-2" aria-label={ta("transcript")}>
        {last.map((l) => <p key={l.id} dir="auto" className={cn("rounded-2xl px-4 py-2 text-sm", l.who === "you" ? "ms-auto max-w-[85%] bg-white/10 text-white/80" : "me-auto max-w-[90%] bg-[#20ac6a]/15 text-white")}>{l.text}</p>)}
      </section>
      <footer className="space-y-6 pb-2">
        {inCall ? (
          <div className="flex items-end justify-center gap-8">
            <Round label={k.muted ? ta("unmute") : ta("mute")} onClick={k.toggleMute} active={k.muted} disabled={!live}>{k.muted ? <MicOff className="size-7" /> : <Mic className="size-7" />}</Round>
            <Round label={ta("hangUp")} onClick={k.hangUp} big className="bg-[#e5484d] active:bg-[#c9363b]"><PhoneOff className="size-9" /></Round>
            <Round label={ta("stopTalking")} onClick={k.interrupt} disabled={!k.speaking}><VolumeX className="size-7" /></Round>
          </div>
        ) : (
          <div className="flex justify-center"><Round label={k.status === "ended" ? ta("callAgain") : ta("call")} onClick={k.call} big className="bg-[#20ac6a] active:bg-[#1a9159]"><Phone className="size-9" /></Round></div>
        )}
        <p className="text-center text-[11px] text-white/35">{t("footer")}</p>
      </footer>
      <audio ref={k.audioEl} autoPlay playsInline className="hidden" />
    </Screen>
  );
}
function Round({ children, label, onClick, big, active, disabled, className }: { children: React.ReactNode; label: string; onClick: () => void; big?: boolean; active?: boolean; disabled?: boolean; className?: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled} className={cn("grid place-items-center rounded-full transition active:scale-95 disabled:opacity-30", big ? "size-20" : "size-16", active ? "bg-white text-black" : "bg-white/15", className)}>{children}</button>
      <span className="text-xs text-white/70">{label}</span>
    </div>
  );
}
