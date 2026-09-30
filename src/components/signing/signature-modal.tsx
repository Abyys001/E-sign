"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import SignaturePad from "signature_pad";
import { Eraser, ImageUp, PenLine, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Checkbox, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { INK, imageFileToDataUrl, renderTyped } from "./canvas";

export type SigValue = { method: "TYPED" | "DRAWN" | "UPLOADED"; typedText?: string; imageDataUrl: string };
type Mode = "typed" | "drawn" | "uploaded";

/** Typed, drawn or uploaded signature/initials. Produces an image; the server records who/when/how as evidence. */
export function SignatureModal({ open, kind, name, allowed, onAdopt, onClose, offerReuse }: { open: boolean; kind: "signature" | "initials"; name: string; allowed: { typed: boolean; drawn: boolean; uploaded: boolean }; onAdopt: (v: SigValue, reuse: boolean) => void; onClose: () => void; offerReuse?: boolean }) {
  const t = useTranslations("signing.sig");
  const cm = useTranslations("common");
  const modes = (["typed", "drawn", "uploaded"] as const).filter((m) => allowed[m]);
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]).join("").slice(0, 4).toUpperCase();
  const [mode, setMode] = useState<Mode>(modes[0] ?? "typed");
  const [text, setText] = useState("");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reuse, setReuse] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<SignaturePad | null>(null);
  useEffect(() => {
    if (open) { setText(kind === "initials" ? initials : name); setDrawn(null); setUploaded(null); setErr(null); setMode(modes[0] ?? "typed"); }
    // Reset only when the dialog opens or changes kind; modes/initials are stable props for that kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, name]);
  useEffect(() => {
    if (!open || mode !== "drawn" || !canvas.current) return;
    const c = canvas.current; const ratio = Math.max(window.devicePixelRatio || 1, 1);
    c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio; c.getContext("2d")!.scale(ratio, ratio);
    const p = new SignaturePad(c, { penColor: INK, minWidth: 0.8, maxWidth: 2.6 });
    p.addEventListener("endStroke", () => setDrawn(p.isEmpty() ? null : p.toDataURL("image/png")));
    pad.current = p; return () => { p.off(); pad.current = null; };
  }, [open, mode]);
  const typedUrl = mode === "typed" && text.trim() ? renderTyped(text.trim(), kind === "initials" ? 360 : 720, kind === "initials" ? 200 : 240) : "";
  const url = mode === "typed" ? typedUrl : mode === "drawn" ? drawn : uploaded;
  const adopt = () => { if (!url) return; onAdopt({ method: mode === "typed" ? "TYPED" : mode === "drawn" ? "DRAWN" : "UPLOADED", typedText: mode === "typed" ? text.trim() : undefined, imageDataUrl: url }, reuse); };
  const ICON = { typed: Type, drawn: PenLine, uploaded: ImageUp } as const;
  return (
    <Modal open={open} onClose={onClose} title={kind === "initials" ? t("titleInitials") : t("title")} size="md"
      footer={<><Button onClick={onClose}>{cm("cancel")}</Button><Button variant="primary" disabled={!url} onClick={adopt}>{kind === "initials" ? t("adoptInitials") : t("adopt")}</Button></>}>
      <div className="space-y-4">
        {modes.length > 1 && <div role="tablist" className="inline-flex rounded-xl border border-line-strong p-0.5">{modes.map((m) => { const I = ICON[m]; return <button key={m} role="tab" type="button" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm transition", mode === m ? "bg-fg text-bg" : "hover:bg-surface-2")}><I className="size-4" aria-hidden />{t(m === "typed" ? "type" : m === "drawn" ? "draw" : "upload")}</button>; })}</div>}
        {mode === "typed" && <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={80} placeholder={t("typePh")} aria-label={t("typePh")} autoFocus className="h-12 text-base" />}
        {mode === "drawn" && <div><canvas ref={canvas} aria-label={t("draw")} className="h-52 w-full touch-none rounded-xl border-2 border-dashed border-line-strong bg-white" /><div className="mt-2 flex items-center justify-between text-xs text-muted"><span>{t("drawHint")}</span><button type="button" onClick={() => { pad.current?.clear(); setDrawn(null); }} className="inline-flex items-center gap-1 underline"><Eraser className="size-3.5" aria-hidden />{t("clear")}</button></div></div>}
        {mode === "uploaded" && <div className="space-y-2"><p className="text-sm text-muted">{t("uploadHint")}</p><input type="file" accept="image/png,image/jpeg" aria-label={t("choose")} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setErr(null); try { const d = await imageFileToDataUrl(f); if (d.length > 1_900_000) setErr(t("tooBig")); else setUploaded(d); } catch { setErr(t("tooBig")); } }} className="block w-full text-sm file:me-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-2" />{err && <p role="alert" className="text-sm">⚠ {err}</p>}</div>}
        {mode === "typed" && url && <div><p className="mb-1 text-xs text-muted">{t("preview")}</p><div className="grid h-28 place-items-center rounded-xl bg-white ring-1 ring-line"><img src={url} alt={t("preview")} className="max-h-24 max-w-full" /></div></div>}
        {offerReuse && kind === "signature" && <Checkbox label={t("reuse")} checked={reuse} onChange={(e) => setReuse(e.target.checked)} />}
      </div>
    </Modal>
  );
}
