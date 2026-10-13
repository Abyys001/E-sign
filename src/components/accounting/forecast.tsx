"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, TrendingDown } from "lucide-react";
import { Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/components/ui/cn";
import { useApi } from "@/lib/api";
import { currencyExponent } from "@/lib/money";

type Kind = "stripe_release" | "organisers" | "bills" | "wages" | "reimbursements" | "profit_share" | "running_costs";
type Horizon = { days: number; date: string; inflows: number; outflows: number; estimated: number; balance: number; free: number; byKind: Partial<Record<Kind, number>> };
type F = { currency: string; start: number; held: number; pendingTotal: number; horizons: Horizon[]; low: { date: string; balance: number }; firstShort: string | null; beyond: number; monthlyCosts: number };
type Data = { asOf: string; today: string; horizons: number[]; forecasts: F[]; consolidated: { currency: string; source: string; horizons: Array<{ days: number; free: number; balance: number; missing: string[] }> } | null; assumptions: { organiserPayDays: number; runRate: boolean } };
const KINDS: Kind[] = ["stripe_release", "organisers", "bills", "wages", "reimbursements", "profit_share", "running_costs"];

/** 7 / 30 / 90-day cash forecast (an estimate from records in the books; nothing is posted). Filtered by the page's currency picker. */
export function ForecastCard({ currency }: { currency: string | null }) {
  const t = useTranslations("accounting.forecast");
  const { q } = useMode();
  const { data, loading, error } = useApi<Data>(q("/api/accounting/forecast?x=1"));
  const [days, setDays] = useState(30);
  if (loading && !data) return <Skeleton className="h-64" />;
  if (error || !data) return <Callout tone="warn">{error?.message ?? t("failed")}</Callout>;
  const list = data.forecasts.filter((f) => (!currency || f.currency === currency) && (f.start || f.horizons.some((h) => h.inflows || h.outflows)));
  const con = !currency ? data.consolidated?.horizons.find((h) => h.days === days) : null;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><CalendarClock className="size-4" aria-hidden />{t("title")}</span>} description={t("sub")} action={
        <div role="group" aria-label={t("horizon")} className="flex gap-1">{data.horizons.map((d) => <Button key={d} size="sm" variant={d === days ? "primary" : "ghost"} aria-pressed={d === days} onClick={() => setDays(d)}>{t("days", { n: d })}</Button>)}</div>} />
      {con && data.consolidated && <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-5 py-3">
        <span className="text-sm text-muted">{t("totalIn", { days, c: data.consolidated.currency.toUpperCase() })}</span>
        <span className={cn("num text-2xl font-semibold", con.free < 0 ? "text-fin-neg" : "text-fin-pos")}><Money v={con.free} c={data.consolidated.currency} /></span>
        <span className="text-xs text-muted">{t("indicative", { source: data.consolidated.source })}</span>
      </div>}
      <TableWrap><Table>
        <thead><tr><Th>{t("currency")}</Th><Th className="text-end">{t("start")}</Th><Th className="text-end">{t("in")}</Th><Th className="text-end">{t("out")}</Th><Th className="text-end">{t("estimated")}</Th><Th className="text-end">{t("end", { days })}</Th><Th className="text-end">{t("lowest")}</Th></tr></thead>
        <tbody>{list.map((f) => { const h = f.horizons.find((x) => x.days === days)!; return (
          <Tr key={f.currency} className={cn(h.free < 0 && "bg-fin-neg/5")}>
            <Td><div className="font-semibold uppercase">{f.currency}</div><div className="text-xs text-muted">{KINDS.filter((k) => h.byKind[k]).map((k) => `${t(`k.${k}`)} ${(h.byKind[k]! / 10 ** currencyExponent(f.currency)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`).join(" · ")}</div></Td>
            <Td className="text-end"><Money v={f.start} c={f.currency} /></Td>
            <Td className="text-end text-fin-pos"><Money v={h.inflows} c={f.currency} /></Td>
            <Td className="text-end text-fin-neg"><Money v={-h.outflows} c={f.currency} /></Td>
            <Td className="text-end text-muted">{h.estimated ? <Money v={-h.estimated} c={f.currency} /> : "—"}</Td>
            <Td className={cn("text-end font-semibold", h.free < 0 ? "text-fin-neg" : "text-fin-pos")}><Money v={h.free} c={f.currency} />{f.held > 0 && <span className="block text-xs font-normal text-muted">{t("held")} <Money v={f.held} c={f.currency} /></span>}</Td>
            <Td className="text-end"><Money v={f.low.balance} c={f.currency} className={cn(f.low.balance < 0 && "text-fin-neg")} /><span className="block text-xs text-muted">{f.low.date}</span></Td>
          </Tr>); })}
          {!list.length && <Tr><Td colSpan={7} className="text-center text-muted">{t("none")}</Td></Tr>}
        </tbody>
      </Table></TableWrap>
      <div className="space-y-2 px-5 py-4">
        {list.filter((f) => f.firstShort && f.firstShort <= f.horizons.find((x) => x.days === days)!.date).map((f) => <Callout key={f.currency} tone="warn" icon={<TrendingDown className="size-4" aria-hidden />}>{t("short", { c: f.currency.toUpperCase(), date: f.firstShort! })}</Callout>)}
        <p className="text-xs text-muted">{t("assumptions", { payDays: data.assumptions.organiserPayDays })} {data.assumptions.runRate ? t("runRateOn") : t("runRateOff")} {t("excluded")} <Link href="/accounting/settings#monitor" className="font-medium text-accent hover:underline">{t("change")}</Link></p>
      </div>
    </Card>
  );
}
