"use client";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "./cn";

export type MenuItem = { label: string; icon?: React.ReactNode; onSelect?: () => void; href?: string; danger?: boolean; disabled?: boolean; separatorBefore?: boolean };

/** Accessible menu button: arrow-key navigation, Escape, outside-click close, focus returns to the trigger. */
export function Dropdown({ trigger, items, label, align = "end" }: { trigger: React.ReactNode; items: MenuItem[]; label: string; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  const key = (e: React.KeyboardEvent) => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { setOpen(false); btn.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  return (
    <div ref={root} className="relative inline-block" onKeyDown={key}>
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label={label} onClick={() => setOpen((v) => !v)} className="rounded-xl">{trigger}</button>
      {open && (
        <div id={id} role="menu" aria-label={label} className={cn("pop absolute z-50 mt-1.5 min-w-52 rounded-xl border border-line bg-surface p-1 shadow-card", align === "end" ? "end-0" : "start-0")}>
          {items.map((it, n) => {
            const cls = "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-50";
            const inner = <>{it.icon}<span>{it.label}</span></>;
            return (
              <div key={n}>
                {it.separatorBefore && <div role="separator" className="my-1 h-px bg-line" />}
                {it.href
                  ? <a role="menuitem" href={it.href} className={cls} onClick={() => setOpen(false)}>{inner}</a>
                  : <button role="menuitem" type="button" disabled={it.disabled} className={cn(cls, it.danger && "font-medium")} onClick={() => { setOpen(false); it.onSelect?.(); }}>{inner}</button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
