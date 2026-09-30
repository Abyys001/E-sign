import { cn } from "./cn";

export type TimelineItem = { id: string; icon: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; detail?: React.ReactNode; state?: "done" | "current" | "todo" };

/** Vertical timeline. State is shown by icon fill and line style, not colour alone. */
export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative">
      {items.map((it, i) => (
        <li key={it.id} className="relative flex gap-3.5 pb-6 last:pb-0">
          {i < items.length - 1 && <span aria-hidden className={cn("absolute start-[15px] top-8 h-[calc(100%-2rem)] w-px", it.state === "done" ? "bg-accent" : "border-s border-dashed border-line-strong")} />}
          <span className={cn("relative z-10 grid size-8 shrink-0 place-items-center rounded-full border text-fg", it.state === "done" ? "border-accent bg-accent text-accent-fg" : it.state === "current" ? "border-2 border-fg bg-surface" : "border-dashed border-line-strong bg-surface text-muted")}>{it.icon}</span>
          <div className="min-w-0 pt-1"><div className="text-sm font-medium">{it.title}</div>{it.meta && <div className="text-xs text-muted">{it.meta}</div>}{it.detail && <div className="mt-1 text-sm text-muted">{it.detail}</div>}</div>
        </li>
      ))}
    </ol>
  );
}
