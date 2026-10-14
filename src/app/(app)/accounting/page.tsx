"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Banknote, Coins, HandCoins, Landmark, Percent, PiggyBank, Receipt, Scale, ShieldAlert, Undo2, Users, Wallet, Wand2 } from "lucide-react";
import { StripeBalance, StripePayouts } from "@/components/accounting/payments";
import { FinanceShortcuts, Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey } from "@/components/accounting/kit";
import { AlertsPanel, Breakdown, fillSeries, Kpi, OrganiserLiabilities, RecentTransactions, RevenueChart, StripeStatus, type SeriesPoint } from "@/components/accounting/command-centre";
import { AccountantWidget, askAccountant } from "@/components/accounting/ai-accountant";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useApi } from "@/lib/api";
import { formatMoney } from "@/lib/money";

type Cur = {
  currency: string; grossSales: number; refunds: number; chargebacks: number; netSales: number; stripeFees: number; stripeFeesRecharged: number; netStripeFees: number; commission: number; eventFees: number;
  otherRevenue: number; otherCosts: number; bilitRevenue: number; organiserPayable: number; organiserPayments: number; organiserOutstanding: number; bilitProfit: number; stripeBalance: number; payoutsInTransit: number; unallocated: number; suspense: number;
};
type Dash = { mode: string; lastSyncAt: string | null; unreconciled: number; reconciliation: Record<string, number>; currencies: Cur[] };
type Grain = "day" | "week" | "month" | "year";

const CUR_KEY = "bilit.finance.currency";
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The equivalent period immediately before [from, to] (same number of days). Null when the range is open-ended. */
function previousRange(r: { from?: string; to?: string }) {
  if (!r.from || !r.to) return null;
  const f = new Date(`${r.from}T00:00:00Z`), to = new Date(`${r.to}T00:00:00Z`);
  const days = Math.round((to.getTime() - f.getTime()) / 86_400_000) + 1;
  const pTo = new Date(f.getTime() - 86_400_000), pFrom = new Date(pTo.getTime() - (days - 1) * 86_400_000);
  return { from: iso(pFrom), to: iso(pTo) };
}
const defaultGrain = (k: RangeKey): Grain => (["today", "yesterday", "week", "month", "lastMonth"].includes(k) ? "day" : "month");

export default function FinanceDashboard() {
  const t = useTranslations("accounting.dashboard");
  const c = useTranslations("accounting.cc");
  const { q } = useMode();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "month" });
  const [grain, setGrain] = useState<Grain | null>(null);
  const [cur, setCurState] = useState<string | null>(() => { try { return sessionStorage.getItem(CUR_KEY); } catch { return null; } });
  const setCur = (v: string) => { setCurState(v); try { sessionStorage.setItem(CUR_KEY, v); } catch { /* storage may be unavailable */ } };
  const r = rangeFor(range.key, range);
  const prev = previousRange(r);
  const g = grain ?? defaultGrain(range.key);
  const { data, loading, error } = useApi<Dash>(q(`/api/accounting/dashboard?x=1${rangeQuery(r)}`));
  const before = useApi<Dash>(prev ? q(`/api/accounting/dashboard?x=1${rangeQuery(prev)}`) : null);
  const series = useApi<{ items: Array<SeriesPoint & { currency: string }> }>(q(`/api/accounting/dashboard/series?grain=${g}${rangeQuery(r)}`));
  const selected = data?.currencies.find((x) => x.currency === cur) ?? data?.currencies[0];
  // previous-period figures: undefined = no comparison possible (open range / still loading); a missing currency = 0
  const p = prev && before.data ? before.data.currencies.find((x) => x.currency === selected?.currency) ?? null : undefined;
  const pv = (f: (x: Cur) => number) => (p === undefined ? undefined : p === null ? 0 : f(p));
  const points = fillSeries((series.data?.items ?? []).filter((x) => x.currency === selected?.currency), g, r.from, r.to);
  const net = (x: Cur) => x.grossSales - x.refunds - x.chargebacks - x.stripeFees;

  const curPicker = data && data.currencies.length > 0 && selected && (
    <label className="flex items-center gap-2 text-sm text-muted">
      <Coins className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">{t("currency")}</span>
      <Select value={selected.currency} onChange={(e) => setCur(e.target.value)} className="w-auto min-w-24 font-semibold uppercase text-fg">
        {data.currencies.map((x) => <option key={x.currency} value={x.currency}>{x.currency.toUpperCase()}</option>)}
      </Select>
    </label>
  );
  return (
    <div>
      <PageHeader title={c("title")} description={c("sub")} actions={<>{curPicker}<RangePicker value={range} onChange={(v) => { setRange(v); setGrain(null); }} /></>} />
      <FinanceShortcuts />
      {loading && !data ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-40" />)}</div>
        : error || !data ? <EmptyState title={t("title")} description={error?.message} />
        : !selected ? <Card><EmptyState icon={<Receipt className="size-6" aria-hidden />} title={t("empty")} description={t("emptyDesc")} action={<LinkButton href="/accounting/stripe" variant="primary">{t("connect")}</LinkButton>} /></Card>
        : <>
          <p className="mb-3 text-xs text-muted">{prev ? c("comparing", { from: prev.from, to: prev.to }) : c("noCompare")}</p>
          <section aria-label={c("kpis")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label={c("k.gross")} def={c("d.gross")} v={selected.grossSales} prev={pv((x) => x.grossSales)} c={selected.currency} icon={Receipt} tone="pos" href="/accounting/transactions?kind=SALE" />
            <Kpi label={c("k.fees")} def={c("d.fees")} v={selected.stripeFees} prev={pv((x) => x.stripeFees)} c={selected.currency} icon={Percent} tone="warn" lowerIsBetter sub={<>{t("recharged")}: <Money v={selected.stripeFeesRecharged} c={selected.currency} /></>} />
            <Kpi label={c("k.refunds")} def={c("d.refunds")} v={selected.refunds + selected.chargebacks} prev={pv((x) => x.refunds + x.chargebacks)} c={selected.currency} icon={Undo2} tone="neg" lowerIsBetter href="/accounting/refunds" sub={selected.chargebacks ? <>{t("chargebacks")}: <Money v={selected.chargebacks} c={selected.currency} /></> : undefined} />
            <Kpi label={c("k.net")} def={c("d.net")} v={net(selected)} prev={pv(net)} c={selected.currency} icon={Wallet} tone="info" />
            <Kpi label={c("k.liabilities")} def={c("d.liabilities")} v={selected.organiserPayable} prev={pv((x) => x.organiserPayable)} c={selected.currency} icon={Users} tone="info" href="/accounting/organisers" />
            <Kpi label={c("k.paid")} def={c("d.paid")} v={selected.organiserPayments} prev={pv((x) => x.organiserPayments)} c={selected.currency} icon={Banknote} href="/accounting/payments" />
            <Kpi label={c("k.outstanding")} def={c("d.outstanding")} v={selected.organiserOutstanding} c={selected.currency} icon={Scale} tone="warn" href="/accounting/payouts" />
            <Kpi label={c("k.profit")} def={c("d.profit")} v={selected.bilitProfit} prev={pv((x) => x.bilitProfit)} c={selected.currency} icon={HandCoins} tone="pos" href="/accounting/position" />
          </section>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
            <span className="flex items-center gap-1.5"><PiggyBank className="size-3.5" aria-hidden />{t("bilitRevenue")}: <Money v={selected.bilitRevenue} c={selected.currency} className="font-medium text-fg" /></span>
            <span className="flex items-center gap-1.5"><Landmark className="size-3.5" aria-hidden />{t("stripeBalance")}: <Money v={selected.stripeBalance} c={selected.currency} className="font-medium text-fg" /></span>
            <span className="flex items-center gap-1.5"><ShieldAlert className="size-3.5" aria-hidden />{t("unallocated")}: <Money v={selected.unallocated} c={selected.currency} className={cn("font-medium", selected.unallocated ? "text-fin-warn" : "text-fg")} /></span>
            <button type="button" onClick={() => askAccountant({ label: c("k.profit"), value: formatMoney(selected.bilitProfit, selected.currency) })} className="ms-auto inline-flex items-center gap-1.5 font-medium text-fg underline-offset-4 hover:underline"><Wand2 className="size-3.5" aria-hidden />{c("askAi")}</button>
          </div>
          {(selected.unallocated !== 0 || selected.suspense !== 0) && <div className="mt-4"><Callout tone="warn" title={t("attention")}>{t("attentionDesc")} <Link href="/accounting/reconciliation" className="inline-flex items-center gap-1 font-medium underline underline-offset-4">{t("review")}<ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden /></Link></Callout></div>}

          <div className="mt-6 grid items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <Card>
              <CardHeader title={c("chart")} description={c("chartDesc")} />
              <div className="p-5"><div className="mb-3 flex justify-end"><div role="radiogroup" aria-label={c("grain")} className="inline-flex shrink-0 rounded-lg border border-line bg-surface-2 p-0.5 text-xs font-medium">
                  {(["day", "week", "month", "year"] as const).map((x) => <button key={x} type="button" role="radio" aria-checked={g === x} onClick={() => setGrain(x)} className={cn("rounded-md px-2.5 py-1 transition", g === x ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>{c(`g.${x}`)}</button>)}
                </div></div>{!series.data ? <Skeleton className="h-72" /> : points.length ? <RevenueChart points={points} currency={selected.currency} grain={g} /> : <p className="grid h-48 place-items-center text-center text-sm text-muted">{c("noData")}</p>}</div>
            </Card>
            <div id="alerts" className="scroll-mt-24 space-y-6">
              <Card><CardHeader title={c("alerts")} description={c("alertsDesc")} /><div className="p-5"><AlertsPanel /></div></Card>
              <Card><CardHeader title={c("stripe")} /><div className="p-5"><StripeStatus /></div></Card>
            </div>
          </div>

          <Card className="mt-6"><CardHeader title={c("breakdown")} description={c("breakdownDesc")} /><div className="p-5"><Breakdown f={selected} c={selected.currency} /></div></Card>

          <div className="mt-6 grid items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <Card><CardHeader title={c("recent")} description={c("recentDesc")} action={<LinkButton href="/accounting/transactions" size="sm">{c("viewAll")}</LinkButton>} /><RecentTransactions currency={selected.currency} /></Card>
            <Card><CardHeader title={c("liabilities")} description={c("liabilitiesDesc")} action={<LinkButton href="/accounting/organisers" size="sm">{c("viewAll")}</LinkButton>} /><div className="p-5"><OrganiserLiabilities currency={selected.currency} /></div></Card>
          </div>

          <div className="mt-6 space-y-6"><StripeBalance /><StripePayouts /></div>
          <Card className="mt-6"><CardHeader title={t("explainTitle")} description={t("explain")} /></Card>
          <AccountantWidget context={{ from: r.from ?? null, to: r.to ?? null, currency: selected.currency }} />
        </>}
    </div>
  );
}
