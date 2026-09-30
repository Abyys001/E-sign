"use client";
import { cn } from "./cn";

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="scroll-thin flex gap-1 overflow-x-auto border-b border-line"
      onKeyDown={(e) => { const i = tabs.findIndex((t) => t.id === value); if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const d = (e.key === "ArrowRight") === (document.dir !== "rtl") ? 1 : -1; onChange(tabs[(i + d + tabs.length) % tabs.length]!.id); } }}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}
          className={cn("relative -mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm transition", value === t.id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
          {t.label}{t.count !== undefined && <span className="num ms-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-xs">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
