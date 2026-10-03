"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, ArrowRight, Banknote, Coins, HandCoins, Landmark, Percent, PiggyBank, Receipt, RefreshCw, Scale, ShieldAlert, TrendingUp, Undo2, Users, Wallet, type LucideIcon } from "lucide-react";
import { AmountCard, Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey, type Tone } from "@/components/accounting/kit";
import { Card, CardHeader, PageHeader, Stat } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { LinkButton } from "@/components/ui/button";
import { fmtDate, fmtNum, useApi } from "@/lib/api";

type Cur = {
  currency: string; grossSales: number; refunds: number; chargebacks: number; netSales: number; stripeFees: number; stripeFeesRecharged: number; netStripeFees: number; commission: number; eventFees: number;
  otherRevenue: number; otherCosts: number; bilitRevenue: number; organiserPayable: number; organiserPayments: number; organiserOutstanding: number; bilitProfit: number; stripeBalance: number; payoutsInTransit: number; unallocated: number; suspense: number;
};
type Dash = { mode: string; lastSyncAt: string | null; unreconciled: number; reconciliation: Record<string, number>; currencies: Cur[] };

const CUR_KEY = "bilit.finance.currency";

export default function FinanceDashboard() {
  const t = useTranslations("accounting.dashboard");
  const locale = useLocale();
  const { q } = useMode();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "month" });
  const [cur, setCurState] = useState<string | null>(() => { try { return sessionStorage.getItem(CUR_KEY); } catch { return null; } });
  const setCur = (v: string) => { setCurState(v); try { sessionStorage.setItem(CUR_KEY, v); } catch { /* storage may be unavailable */ } };
  const r = rangeFor(range.key, range);
  const { data, loading, error } = useApi<Dash>(q(`/api/accounting/dashboard?x=1${rangeQuery(r)}`));
  const selected = data?.currencies.find((c) => c.currency === cur) ?? data?.currencies[0];
  const curPicker = data && data.currencies.length > 0 && selected && (
    <label className="flex items-center gap-2 text-sm text-muted">
      <Coins className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">{t("currency")}</span>
      <Select value={selected.currency} onChange={(e) => setCur(e.target.value)} className="w-auto min-w-28 font-semibold uppercase text-fg">
        {data.currencies.map((c) => <option key={c.currency} value={c.currency}>{c.currency.toUpperCase()}</option>)}
      </Select>
    </label>
  );
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<>{curPicker}<RangePicker value={range} onChange={setRange} /></>} />
      {loading && !data ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
        : error || !data ? <EmptyState title={t("title")} description={error?.message} />
        : <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t("unreconciled")} value={fmtNum(data.unreconciled, locale)} icon={<AlertTriangle className="size-4" aria-hidden />} hint={<Link href="/accounting/reconciliation" className="underline underline-offset-4">{t("review")}</Link>} />
            <Stat label={t("lastSync")} value={<span className="text-lg">{data.lastSyncAt ? fmtDate(data.lastSyncAt, locale) : t("never")}</span>} icon={<RefreshCw className="size-4" aria-hidden />} hint={<Link href="/accounting/stripe/sync" className="underline underline-offset-4">{t("syncNow")}</Link>} />
          </div>
          {!selected ? <Card><EmptyState icon={<Receipt className="size-6" aria-hidden />} title={t("empty")} description={t("emptyDesc")} action={<LinkButton href="/accounting/stripe" variant="primary">{t("connect")}</LinkButton>} /></Card>
            : <CurrencyBlock key={selected.currency} c={selected} />}
        </>}
    </div>
  );
}

function CurrencyBlock({ c }: { c: Cur }) {
  const t = useTranslations("accounting.dashboard");
  const M = (v: number) => <Money v={v} c={c.currency} className="font-medium text-fg" />;
  const A = (p: { label: string; v: number; tone: Tone; icon: LucideIcon; hint?: React.ReactNode }) => <AmountCard {...p} c={c.currency} />;
  return (
    <section aria-label={c.currency.toUpperCase()} className="mb-8">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {A({ label: t("grossSales"), v: c.grossSales, tone: "pos", icon: Receipt })}
        {A({ label: t("netSales"), v: c.netSales, tone: "pos", icon: TrendingUp, hint: t("netSalesHint") })}
        {A({ label: t("bilitRevenue"), v: c.bilitRevenue, tone: "pos", icon: PiggyBank, hint: <>{t("commission")}: {M(c.commission)}</> })}
        {A({ label: t("bilitProfit"), v: c.bilitProfit, tone: "pos", icon: HandCoins, hint: t("profitHint") })}
        {A({ label: t("refunds"), v: c.refunds, tone: "neg", icon: Undo2 })}
        {A({ label: t("chargebacks"), v: c.chargebacks, tone: "neg", icon: ShieldAlert })}
        {A({ label: t("stripeFees"), v: c.stripeFees, tone: "warn", icon: Percent, hint: <>{t("recharged")}: {M(c.stripeFeesRecharged)}</> })}
        {A({ label: t("unallocated"), v: c.unallocated, tone: "warn", icon: Landmark, hint: t("unallocatedHint") })}
        {A({ label: t("organiserPayable"), v: c.organiserPayable, tone: "info", icon: Users, hint: t("inPeriod") })}
        {A({ label: t("organiserPayments"), v: c.organiserPayments, tone: "info", icon: Banknote, hint: t("inPeriod") })}
        {A({ label: t("outstanding"), v: c.organiserOutstanding, tone: "warn", icon: Scale, hint: t("asOfEnd") })}
        {A({ label: t("stripeBalance"), v: c.stripeBalance, tone: "bal", icon: Wallet, hint: <>{t("inTransit")}: {M(c.payoutsInTransit)}</> })}
      </div>
      {(c.unallocated !== 0 || c.suspense !== 0) && <div className="mt-4"><Callout tone="warn" title={t("attention")}>{t("attentionDesc")} <Link href="/accounting/reconciliation" className="inline-flex items-center gap-1 font-medium underline underline-offset-4">{t("review")}<ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden /></Link></Callout></div>}
      <Card className="mt-4"><CardHeader title={t("explainTitle")} description={t("explain")} /></Card>
    </section>
  );
}
