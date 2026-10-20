"use client";
import Link from "next/link";
import { CalendarDays, ChevronRight } from "lucide-react";
import type { CallCard } from "@/components/accounting/use-accountant-call";
import { cn } from "@/components/ui/cn";

/**
 * The figures behind what the AI Accountant is saying: one card per event / organiser / summary, the key figure
 * highlighted with its label, the breakdown underneath. Values come verbatim from the server (verified lookups).
 */
export function CallCards({ cards, dark, className }: { cards: CallCard[]; dark?: boolean; className?: string }) {
  if (!cards.length) return null;
  const tone = dark
    ? { card: "border-white/10 bg-white/[.06]", muted: "text-white/60", hl: "bg-[#20ac6a]/20 ring-1 ring-[#20ac6a]/40", hlLabel: "text-[#8fe3b9]", row: "border-white/10", link: "text-[#8fe3b9]" }
    : { card: "border-line bg-surface", muted: "text-muted", hl: "bg-accent-soft ring-1 ring-accent/30", hlLabel: "text-fg/70", row: "border-line", link: "text-accent" };
  return (
    <div className={cn("grid gap-3", cards.length > 1 && "sm:grid-cols-2", className)} aria-live="polite">
      {cards.map((c, i) => (
        <article key={`${c.title}-${i}`} className={cn("rounded-2xl border p-4", tone.card)}>
          <header className="mb-3">
            <h3 dir="auto" className="text-base font-semibold leading-snug">{c.title}{c.subtitle && <span className={cn("ms-2 text-xs font-normal", tone.muted)}>{c.subtitle}</span>}</h3>
            {!!c.meta?.length && <p className={cn("mt-1 flex flex-wrap items-center gap-x-2 text-xs", tone.muted)}>{c.kind === "event" && <CalendarDays className="size-3.5" aria-hidden />}{c.meta.join(" · ")}</p>}
          </header>
          {c.highlight && (
            <div className={cn("mb-3 rounded-xl px-4 py-3", tone.hl)}>
              <p className={cn("text-[11px] font-semibold uppercase tracking-wide", tone.hlLabel)}>{c.highlight.label}</p>
              <p className="num text-2xl font-bold tabular-nums">{c.highlight.value}</p>
            </div>
          )}
          {!!c.rows.length && (
            <dl className="space-y-1 text-sm">
              {c.rows.map((r, j) => (
                <div key={j} className={cn("flex items-baseline justify-between gap-3 border-b border-dashed pb-1 last:border-0", tone.row)}>
                  <dt dir="auto" className={cn("min-w-0", tone.muted)}>{r.label}</dt>
                  <dd className={cn("num shrink-0 tabular-nums", r.strong && "font-semibold")}>{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {c.note && <p className={cn("mt-2 text-xs", tone.muted)}>{c.note}</p>}
          {c.link && !dark && <Link href={c.link} className={cn("mt-2 inline-flex items-center gap-1 text-xs font-medium", tone.link)}>Open records<ChevronRight className="size-3" aria-hidden /></Link>}
        </article>
      ))}
    </div>
  );
}
