"use client";
import { useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, Paperclip } from "lucide-react";
import { Badge, Money } from "@/components/accounting/kit";
import type { Fig, PaymentRow } from "@/components/accounting/finance";
import { cn } from "@/components/ui/cn";

export type BoxPayment = PaymentRow & { payee?: string | null };

/**
 * One event = one box office. Its organiser payments as a short statement: what was due, every payment in date order
 * with who received it and what was left after it, ending on the event's real "still to pay" figure.
 */
export function BoxOfficePayments({ items, f, actions, empty }: { items: BoxPayment[]; f: Fig; actions?: (p: BoxPayment) => ReactNode; empty?: ReactNode }) {
  const t = useTranslations("accounting.fin.box");
  const tp = useTranslations("accounting.payments");
  const locale = useLocale();
  const [showVoided, setShowVoided] = useState(false);
  const c = f.currency;
  const live = items.filter((p) => p.status !== "VOIDED" && p.currency === c).sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const voided = items.filter((p) => p.status === "VOIDED");
  // "Left after" is walked back from the event's own remaining figure, so the last row always equals the headline.
  const leftAfter = new Map<string, number>();
  let left = f.remaining;
  for (const p of [...live].reverse()) { leftAfter.set(p.id, left); if (p.status === "PAID") left += p.amount; }
  const pctPaid = f.organiserDue > 0 ? Math.min(100, Math.round((f.organiserPaid / f.organiserDue) * 100)) : 0;
  const done = f.remaining === 0 && f.organiserDue > 0;
  const day = (d: string) => new Date(`${d}T12:00:00Z`);
  const row = (p: BoxPayment, i: number | null) => (
    <li key={p.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap", p.status === "VOIDED" && "opacity-60")}>
      <div className="flex w-12 shrink-0 flex-col items-center rounded-xl bg-surface-2 py-1.5 text-center leading-tight" aria-hidden>
        <span className="text-base font-semibold tabular-nums">{day(p.paymentDate).toLocaleDateString(locale, { day: "numeric", timeZone: "UTC" })}</span>
        <span className="text-[11px] uppercase text-muted">{day(p.paymentDate).toLocaleDateString(locale, { month: "short", timeZone: "UTC" })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate font-medium", p.status === "VOIDED" && "line-through")} title={p.notes ?? undefined}>
          {i !== null && <span className="me-2 text-xs tabular-nums text-muted">{i}.</span>}{p.payee ?? tp(`m.${p.method}`)}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="sr-only">{day(p.paymentDate).toLocaleDateString(locale, { dateStyle: "long", timeZone: "UTC" })} · </span>
          <span>{tp(`m.${p.method}`)}</span>
          {p.bankReference && <code className="max-w-[16rem] truncate rounded bg-surface-2 px-1.5 py-0.5" title={p.bankReference}>{p.bankReference}</code>}
          {p.proofName && <a href={`/api/accounting/organiser-payments/${p.id}/proof`} className="inline-flex items-center gap-1 underline-offset-4 hover:underline" title={p.proofName}><Paperclip className="size-3" aria-hidden />{t("proof")}</a>}
          {p.status !== "PAID" && <Badge s={p.status} />}
          {p.voidReason && <span>{p.voidReason}</span>}
        </p>
      </div>
      <div className="ms-auto text-end">
        <Money v={p.amount} c={p.currency} strong className={cn("text-base", p.status === "VOIDED" && "line-through")} />
        {leftAfter.has(p.id) && p.status === "PAID" && <p className="text-xs tabular-nums text-muted">{t("leftAfter")} <Money v={leftAfter.get(p.id)!} c={c} /></p>}
      </div>
      {actions && <div className="flex w-full justify-end gap-1 sm:w-auto">{actions(p)}</div>}
    </li>
  );
  return (
    <div>
      <div className="grid grid-cols-3 gap-px overflow-hidden border-b border-line bg-line text-sm">
        <div className="bg-surface p-4"><p className="text-xs text-muted">{t("due")}</p><p className="mt-1 text-lg font-semibold tabular-nums"><Money v={f.organiserDue} c={c} /></p></div>
        <div className="bg-surface p-4"><p className="text-xs text-muted">{t("paid")} · {t("count", { n: live.filter((p) => p.status === "PAID").length })}</p><p className="mt-1 text-lg font-semibold tabular-nums text-fin-info"><Money v={f.organiserPaid} c={c} /></p></div>
        <div className="bg-surface p-4"><p className="text-xs text-muted">{t("left")}</p>
          {done ? <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold text-fin-pos"><CheckCircle2 className="size-5" aria-hidden />{t("fullyPaid")}</p>
            : <p className={cn("mt-1 text-lg font-semibold tabular-nums", f.remaining < 0 ? "text-fin-neg" : "text-fin-warn")}><Money v={f.remaining} c={c} /></p>}
        </div>
      </div>
      {f.organiserDue > 0 && (
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pctPaid} aria-label={t("pctPaid", { p: pctPaid })}>
            <div className={cn("h-full rounded-full", done ? "bg-fin-pos" : "bg-fin-info")} style={{ width: `${pctPaid}%` }} />
          </div>
          <span className="text-xs tabular-nums text-muted">{t("pctPaid", { p: pctPaid })}</span>
        </div>
      )}
      {live.length ? <ol className="divide-y divide-line">{live.map((p, i) => row(p, i + 1))}</ol> : (empty ?? <p className="px-4 py-6 text-center text-sm text-muted">{t("empty")}</p>)}
      {voided.length > 0 && <div className="border-t border-line">
        <button type="button" onClick={() => setShowVoided((v) => !v)} className="w-full px-4 py-2.5 text-start text-xs text-muted hover:bg-surface-2" aria-expanded={showVoided}>{showVoided ? t("hideVoided") : t("showVoided", { n: voided.length })}</button>
        {showVoided && <ol className="divide-y divide-line">{voided.map((p) => row(p, null))}</ol>}
      </div>}
    </div>
  );
}
