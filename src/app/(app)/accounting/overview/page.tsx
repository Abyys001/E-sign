"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Banknote, CalendarDays, Coins, HandCoins, PiggyBank, Receipt, Scale, Wallet } from "lucide-react";
import { AmountCard, Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey } from "@/components/accounting/kit";
import { BarList, ColumnChart, type Fig } from "@/components/accounting/finance";
import { Card, CardHeader, PageHeader, Stat } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { useApi } from "@/lib/api";

type Month = { month: string; currency: string; grossSales: number; bookingFees: number; organiserPaid: number; expenses: number; bilitProfit: number };
type Overview = {
  totalEvents: number; activeEvents: number; totals: Array<Fig & { events: number }>; monthly: Month[];
  converted: { currency: string; totals: Record<string, number>; missing: string[] } | null;
  profitByEvent: Array<{ eventId: string; eventName: string; currency: string; profit: number }>;
  outstanding: Array<{ organiserId: string; organiserName: string; currency: string; remaining: number }>;
};
const CUR_KEY = "bilit.finance.overview.currency";

export default function OverviewPage() {
  const t = useTranslations("accounting.fin.overview");
  const tf = useTranslations("accounting.fin");
  const { q } = useMode();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "year" });
  const [cur, setCurState] = useState<string | null>(() => { try { return sessionStorage.getItem(CUR_KEY); } catch { return null; } });
  const setCur = (v: string) => { setCurState(v); try { sessionStorage.setItem(CUR_KEY, v); } catch { /* storage may be unavailable */ } };
  const r = rangeFor(range.key, range);
  const { data, loading, error } = useApi<Overview>(q(`/api/accounting/finance/overview?x=1${rangeQuery(r)}`));
  const totals = data?.totals.filter((x) => x.grossSales || x.organiserDue || x.organiserPaid || x.bilitProfit) ?? [];
  const sel = totals.find((x) => x.currency === cur) ?? totals[0];
  const months = data && sel ? data.monthly.filter((m) => m.currency === sel.currency) : [];
  const series = (k: keyof Omit<Month, "month" | "currency">) => months.map((m) => ({ label: m.month.slice(2).replace("-", "/"), sub: m.month, value: m[k] }));
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        {totals.length > 0 && sel && <label className="flex items-center gap-2 text-sm text-muted"><Coins className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">{tf("currency")}</span>
          <Select value={sel.currency} onChange={(e) => setCur(e.target.value)} className="w-auto min-w-24 font-semibold uppercase text-fg">{totals.map((c) => <option key={c.currency} value={c.currency}>{c.currency.toUpperCase()}</option>)}</Select></label>}
        <RangePicker value={range} onChange={setRange} keys={["month", "lastMonth", "year", "all", "custom"]} /></>} />
      {loading && !data ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
        : error || !data ? <EmptyState title={t("title")} description={error?.message} />
        : !sel ? <Card><EmptyState title={t("empty")} description={t("emptyDesc")} /></Card>
        : <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t("totalEvents")} value={data.totalEvents} icon={<CalendarDays className="size-4" aria-hidden />} hint={t("activeEvents", { n: sel.events })} />
            <AmountCard label={t("ticketSales")} v={sel.grossSales} c={sel.currency} tone="pos" icon={Receipt} hint={<>{tf("k.tickets")}: {sel.tickets.toLocaleString()}</>} />
            <AmountCard label={t("bookingFees")} v={sel.bookingFees} c={sel.currency} tone="pos" icon={Coins} />
            <AmountCard label={t("organiserPayments")} v={sel.organiserPaid} c={sel.currency} tone="bal" icon={Banknote} />
            <AmountCard label={t("expenses")} v={sel.expensesBilit} c={sel.currency} tone="warn" icon={Wallet} hint={t("expensesHint")} />
            <AmountCard label={t("profit")} v={sel.bilitProfit} c={sel.currency} tone="pos" icon={PiggyBank} />
            <AmountCard label={t("outstanding")} v={sel.remaining} c={sel.currency} tone="warn" icon={Scale} hint={t("outstandingHint")} />
            <AmountCard label={tf("k.refunds")} v={sel.refunds + sel.chargebacks} c={sel.currency} tone="neg" icon={HandCoins} />
          </div>

          {data.converted && <Card className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold">{t("converted", { c: data.converted.currency.toUpperCase() })}</h2><span className="text-xs text-muted">{t("convertedNote")}</span></div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 xl:grid-cols-6">
              {(["grossSales", "bookingFees", "organiserPaid", "expensesBilit", "bilitProfit", "remaining"] as const).map((k) => <div key={k}><dt className="text-xs text-muted">{tf(`k.${k}`)}</dt><dd className="text-base font-semibold">≈ <Money v={data.converted!.totals[k] ?? 0} c={data.converted!.currency} /></dd></div>)}
            </dl>
            {data.converted.missing.length > 0 && <div className="mt-3"><Callout tone="warn">{t("missingRates", { list: data.converted.missing.map((x) => x.toUpperCase()).join(", ") })}</Callout></div>}
          </Card>}

          {months.length > 0 && <div className="grid gap-6 lg:grid-cols-2">
            {([["revenue", "grossSales"], ["fees", "bookingFees"], ["payments", "organiserPaid"], ["profitMonth", "bilitProfit"]] as const).map(([k, s]) => (
              <Card key={k}><CardHeader title={t(`charts.${k}`)} description={sel.currency.toUpperCase()} /><div className="p-5"><ColumnChart data={series(s)} currency={sel.currency} caption={`${t(`charts.${k}`)} (${sel.currency.toUpperCase()})`} /></div></Card>
            ))}
          </div>}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader title={t("charts.profitEvent")} description={sel.currency.toUpperCase()} /><div className="p-5">
              {(() => { const d = data.profitByEvent.filter((x) => x.currency === sel.currency).slice(0, 12); return d.length ? <BarList data={d.map((x) => ({ label: x.eventName, value: x.profit }))} currency={sel.currency} caption={t("charts.profitEvent")} href={(i) => `/accounting/events/${d[i]!.eventId}`} /> : <p className="text-sm text-muted">{t("none")}</p>; })()}
            </div></Card>
            <Card><CardHeader title={t("charts.outstanding")} description={sel.currency.toUpperCase()} /><div className="p-5">
              {(() => { const d = data.outstanding.filter((x) => x.currency === sel.currency).slice(0, 12); return d.length ? <BarList data={d.map((x) => ({ label: x.organiserName, value: x.remaining }))} currency={sel.currency} caption={t("charts.outstanding")} href={(i) => `/accounting/organisers/${d[i]!.organiserId}`} /> : <p className="text-sm text-muted">{t("noneOutstanding")}</p>; })()}
            </div></Card>
          </div>
        </>}
    </div>
  );
}
