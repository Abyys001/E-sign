"use client";
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Mic, MicOff, Phone, PhoneOff, Volume2 } from "lucide-react";
import { useMode } from "@/components/accounting/kit";
import { useAccountantCall, type CallLine } from "@/components/accounting/use-accountant-call";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { cn } from "@/components/ui/cn";

const csrf = () => document.cookie.split("; ").find((c) => c.startsWith("bes_csrf="))?.slice(9) ?? "";

/** Texts the call engine shows, from the translations. */
export function useCallText() {
  const t = useTranslations("accounting.aicall");
  return { micLost: t("micLost"), failed: t("failed"), dropped: t("dropped"), unsupported: t("unsupported"), micDenied: t("micDenied"), voiceFailed: t("voiceFailed"), timeLimit: (n: number) => t("timeLimit", { n }), lookingUp: (what: string) => t("lookingUp", { what }) };
}

export function CallTranscript({ lines, className }: { lines: CallLine[]; className?: string }) {
  const t = useTranslations("accounting.aicall");
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lines]);
  if (!lines.length) return null;
  return (
    <div ref={log} className={cn("space-y-2 overflow-y-auto", className)} aria-label={t("transcript")}>
      {lines.map((l) => (
        <div key={l.id} dir="auto" className={cn("text-sm", l.who === "tool" ? "text-xs italic opacity-70" : l.who === "you" ? "ms-auto max-w-[85%] rounded-xl bg-surface-2 px-3 py-2" : "me-auto max-w-[85%] rounded-xl border border-line px-3 py-2")}>
          {l.who !== "tool" && <span className="block text-[11px] font-semibold uppercase tracking-wide opacity-70">{l.who === "you" ? t("you") : t("ai")}</span>}{l.text}
        </div>
      ))}
    </div>
  );
}

/** Live voice call with the AI Accountant, on the finance call page. */
export function AccountantCall() {
  const t = useTranslations("accounting.aicall");
  const { q, mode } = useMode();
  const k = useAccountantCall({ session: q("/api/accounting/ai/call/session"), tool: q("/api/accounting/ai/call/tool"), speak: q("/api/accounting/ai/call/speak"), headers: () => ({ "x-csrf-token": csrf() }) }, useCallText());
  const live = k.status === "live", connecting = k.status === "connecting";
  const clock = `${Math.floor(k.secs / 60)}:${String(k.secs % 60).padStart(2, "0")}`;
  const label = connecting ? t("connecting") : live ? (k.busy ? t("lookingUp", { what: k.busy }) : k.speaking ? t("speaking") : k.muted ? t("muted") : t("listening")) : k.status === "ended" ? t("ended") : t("ready");
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-8 text-center">
        <div className={cn("flex size-24 items-center justify-center rounded-full transition", live ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted", live && !k.muted && "animate-pulse")}>
          {connecting ? <Loader2 className="size-10 animate-spin" aria-hidden /> : live && k.speaking ? <Volume2 className="size-10" aria-hidden /> : live && k.muted ? <MicOff className="size-10" aria-hidden /> : <Phone className="size-10" aria-hidden />}
        </div>
        <div aria-live="polite">
          <p className="text-lg font-semibold">{label}</p>
          <p className="text-sm text-muted">{live ? `${clock} · ${t("books", { mode: mode.toUpperCase() })}` : t("hint")}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {live || connecting ? (
            <>
              <Button size="lg" onClick={k.toggleMute} disabled={!live} aria-pressed={k.muted}>{k.muted ? <Mic className="size-5" aria-hidden /> : <MicOff className="size-5" aria-hidden />}{k.muted ? t("unmute") : t("mute")}</Button>
              {k.speaking && <Button size="lg" onClick={k.interrupt}>{t("stopTalking")}</Button>}
              <Button size="lg" variant="danger" onClick={k.hangUp}><PhoneOff className="size-5" aria-hidden />{t("hangUp")}</Button>
            </>
          ) : (
            <Button size="lg" variant="primary" onClick={k.call}><Phone className="size-5" aria-hidden />{k.status === "ended" ? t("callAgain") : t("call")}</Button>
          )}
        </div>
      </div>
      {k.err && <Callout tone="warn" title={t("problem")}>{k.err}</Callout>}
      <CallTranscript lines={k.lines} className="max-h-[50vh] rounded-2xl border border-line bg-surface p-4" />
      <p className="text-xs text-muted">{t("privacy")}</p>
      <audio ref={k.audioEl} autoPlay playsInline className="hidden" />
    </div>
  );
}
