"use client";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "./cn";

/** Native <dialog>: focus trap, Escape, inert background and top-layer stacking come from the browser. */
export function Modal({ open, onClose, title, description, children, footer, size = "md", side }: { open: boolean; onClose: () => void; title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl"; side?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useTranslations("common");
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="modal-title"
      className={cn("m-auto w-[calc(100%-1.5rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-[color-mix(in_srgb,var(--color-3)_55%,transparent)] backdrop:backdrop-blur-sm open:pop", side && "ms-auto me-0 mt-0 mb-0 h-dvh max-h-dvh rounded-none rounded-s-2xl", { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size])}>
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div><h2 id="modal-title" className="text-base font-semibold">{title}</h2>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>
            <button type="button" onClick={onClose} aria-label={t("close")} className="grid size-8 place-items-center rounded-lg hover:bg-surface-2"><X className="size-4" /></button>
          </div>
          {children ? <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div> : null}
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
