"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertOctagon, AlertTriangle, Banknote, Boxes, Coins, HandCoins, Info, Landmark, PiggyBank, Scale, ShieldCheck, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { AmountCard, Money, RangePicker, rangeFor, rangeQuery, useMode, useMoney, type RangeKey } from "@/components/accounting/kit";
import { AccountantWidget, askAccountant } from "@/components/accounting/ai-accountant";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/components/ui/cn";
import { useApi } from "@/lib/api";

type Status = "VERIFIED" | "STALE" | "REVIEW" | "UNVERIFIED";
type Pos = { currency: string; cash: number; cashAvailableNow: number; cashRestricted: number; liabilities: number; liabilitiesDueNow: number; organisersOwed: number; organisersDueNow: number; otherLiabilities: number; receivables: number; remaining: number; remainingNow: number; shortfall: number; shortfallNow: number; status: Status };
type CashSource = { id: string; provider: string; label: string; currency: string; amount: number; availableNow: boolean; status: Status; source: string; asOf: string | null; note?: string };
type Liability = { key: string; currency: string; amount: number; dueNow: number; status: Status; accountCodes: string[] };
type Settlement = { organiserId: string; organiserName: string; currency: string; events: number; grossSales: number; refunds: number; netSales: number; bookingFees: number; feesRecharged: number; organiserShare: number; deductions: number; expensesOrganiser: number; due: number; paid: number; pending: number; remaining: number; dueNow: number; dueLater: number; status: string; lastPayment: string | null; eventsOwing: Array<{ eventId: string; eventName: string; amount: number }> };
type Profit = { currency: string; ticketSales: number; revenue: number; directCosts: number; grossProfit: number; operatingExpenses: number; expenses: number; netProfit: number; lines: Array<{ code: string; name: string; type: string; amount: number }> };
type Flow = { account: string; status: Status; currency: string; opening: number; inflows: number; outflows: number; closing: number; byType: Array<{ type: string; inflow: number; outflow: number }> };
type Alert = { id: string; severity: "critical" | "warning" | "info"; title: string; detail: string; currency?: string; amount?: number; href?: string };
type Data = {
  asOf: string; positions: Pos[]; cash: CashSource[]; liabilities: Liability[]; receivables: Array<{ key: string; currency: string; amount: number }>; settlements: Settlement[]; profit: Profit[]; cashFlow: Flow[];
  reconciliation: Array<{ currency: string; stripeBooks: number; stripeReal: number; bankBooks: number; inTransitBooks: number; wiseReal: number }>;
  consolidated: { currency: string; source: string; at: string | null; rates: Record<string, string>; totals: Record<string, number>; missing: string[] } | null;
  alerts: Alert[]; inventory: { applicable: boolean; reason: string };
};
type Drill = { title: string; codes: string[]; currency: string; organiserId?: string; settlement?: Settlement } | null;
const ALL = "__all";

const STATUS_TONE: Record<Status, string> = { VERIFIED: "bg-fin-pos/15 text-fin-pos", STALE: "bg-fin-warn/15 text-fin-warn", REVIEW: "bg-fin-warn/15 text-fin-warn", UNVERIFIED: "bg-fin-neg/15 text-fin-neg" };
function StatusPill({ s }: { s: Status }) {
  const t = useTranslations("accounting.position.status");
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", STATUS_TONE[s])}>{t(s)}</span>;
}
/** A figure that opens the records behind it. */
function DrillMoney({ v, c, onClick, className }: { v: number; c: string; onClick?: () => void; className?: string }) {
  const t = useTranslations("accounting.position");
  if (!onClick) return <Money v={v} c={c} className={className} />;
  return <button type="button" onClick={onClick} title={t("showRecords")} className={cn("rounded underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:outline-2", className)}><Money v={v} c={c} /></button>;
}

export default function FinancialPositionPage() {
  const t = useTranslations("accounting.position");
  const { q } = useMode();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const r = rangeFor(range.key, range);
  const { data, loading, error } = useApi<Data>(q(`/api/accounting/position?x=1${rangeQuery(r)}`));
  const [cur, setCur] = useState<string>(ALL);
  const [orgFilter, setOrgFilter] = useState(""); const [statusFilter, setStatusFilter] = useState("");
  const [provider, setProvider] = useState("");
  const [drill, setDrill] = useState<Drill>(null);

  const main = useMemo(() => (data?.positions ?? []).filter((p) => p.liabilities || Math.abs(p.cash) >= 10_000), [data]);
  const sel = cur === ALL ? null : data?.positions.find((p) => p.currency === cur) ?? null;
  const con = data?.consolidated;
  const profitSel = sel ? data?.profit.find((p) => p.currency === sel.currency) : null;
  const card = (k: keyof Pos) => (sel ? (sel[k] as number) : con ? con.totals[k] ?? 0 : 0);
  const cc = sel?.currency ?? con?.currency ?? "gbp";
  const showCards = !!sel || !!con;
  const settlements = (data?.settlements ?? []).filter((s) => (cur === ALL || s.currency === cur) && (!orgFilter || s.organiserId === orgFilter) && (!statusFilter || s.status === statusFilter));
  const orgs = [...new Map((data?.settlements ?? []).map((s) => [s.organiserId, s.organiserName])).entries()];
  const inCur = <T extends { currency: string }>(xs: T[]) => xs.filter((x) => cur === ALL || x.currency === cur);
  const crit = data?.alerts.filter((a) => a.severity === "critical") ?? [];
  const money = useMoney();
  // "Ask the AI Accountant" about one figure: the widget gets the label, value, period and currency.
  const ask = (label: string, v: number) => ({ onAsk: () => askAccountant({ label, value: money(v, cc) }), askLabel: t("askAi", { label }) });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        {data && <label className="flex items-center gap-2 text-sm text-muted"><Coins className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">{t("currency")}</span>
          <Select value={cur} onChange={(e) => setCur(e.target.value)} className="w-auto min-w-28 font-semibold text-fg">
            <option value={ALL}>{con ? t("allIn", { c: con.currency.toUpperCase() }) : t("all")}</option>
            {main.map((p) => <option key={p.currency} value={p.currency}>{p.currency.toUpperCase()}</option>)}
          </Select></label>}
        <RangePicker value={range} onChange={setRange} keys={["month", "lastMonth", "year", "all", "custom"]} /></>} />

      {loading && !data ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
        : error || !data ? <EmptyState title={t("title")} description={error?.message} />
        : <>
          <p className="text-xs text-muted">{t("asOf", { at: new Date(data.asOf).toLocaleString() })} · {t("periodNote")}</p>

          {/* ----- summary cards ----- */}
          {showCards ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AmountCard {...ask(t("cards.cash"), card("cash"))} label={t("cards.cash")} v={card("cash")} c={cc} tone="info" icon={Landmark} hint={<>{t("cards.cashHint")} <Money v={card("cashAvailableNow")} c={cc} /></>} />
            <AmountCard {...ask(t("cards.revenue"), sel ? profitSel?.revenue ?? 0 : con?.totals.revenue ?? 0)} label={t("cards.revenue")} v={sel ? profitSel?.revenue ?? 0 : con?.totals.revenue ?? 0} c={cc} tone="pos" icon={TrendingUp} hint={<>{t("cards.ticketSales")} <Money v={sel ? profitSel?.ticketSales ?? 0 : con?.totals.ticketSales ?? 0} c={cc} /></>} />
            <AmountCard {...ask(t("cards.netProfit"), sel ? profitSel?.netProfit ?? 0 : con?.totals.netProfit ?? 0)} label={t("cards.netProfit")} v={sel ? profitSel?.netProfit ?? 0 : con?.totals.netProfit ?? 0} c={cc} tone="pos" icon={PiggyBank} hint={t("cards.netProfitHint")} />
            <AmountCard {...ask(t("cards.liabilities"), card("liabilities"))} label={t("cards.liabilities")} v={card("liabilities")} c={cc} tone="warn" icon={Scale} hint={<>{t("cards.dueNow")} <Money v={card("liabilitiesDueNow")} c={cc} /></>} />
            <AmountCard {...ask(t("cards.organisers"), card("organisersOwed"))} label={t("cards.organisers")} v={card("organisersOwed")} c={cc} tone="bal" icon={HandCoins} />
            <AmountCard {...ask(t("cards.remaining"), card("remaining"))} label={t("cards.remaining")} v={card("remaining")} c={cc} tone="pos" icon={Wallet} hint={t("cards.remainingHint")} />
            <div className="rise relative overflow-hidden rounded-card border border-line bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between gap-2 text-sm font-medium text-fg/80"><span>{t("cards.inventory")}</span><span className="grid size-8 place-items-center rounded-lg bg-surface-2"><Boxes className="size-4" aria-hidden /></span></div>
              <div className="num mt-2 text-3xl font-semibold tracking-tight text-muted">{t("na")}</div>
              <div className="mt-1 text-xs text-muted">{t("cards.inventoryHint")}</div>
            </div>
            {(() => { const short = sel ? sel.shortfall : (con?.totals.shortfall ?? 0); const shortCur = data.positions.filter((p) => p.shortfall > 0);
              return short > 0 || (!sel && shortCur.length)
                ? <div className="rise relative overflow-hidden rounded-card border-2 border-fin-neg/60 bg-fin-neg/10 p-5 shadow-card">
                    <div className="flex items-center justify-between gap-2 text-sm font-semibold text-fin-neg"><span>{t("cards.shortfall")}</span><AlertOctagon className="size-5" aria-hidden /></div>
                    <div className="num mt-2 text-3xl font-semibold tracking-tight text-fin-neg"><Money v={short} c={cc} /></div>
                    <div className="mt-1 text-xs text-fg/80">{!sel && shortCur.length ? t("cards.shortIn", { list: shortCur.map((p) => `${(p.shortfall / 100).toLocaleString()} ${p.currency.toUpperCase()}`).join(", ") }) : t("cards.shortHint")}</div>
                  </div>
                : <div className="rise relative overflow-hidden rounded-card border border-fin-pos/30 bg-fin-pos/10 p-5 shadow-card">
                    <div className="flex items-center justify-between gap-2 text-sm font-medium text-fg/80"><span>{t("cards.shortfall")}</span><ShieldCheck className="size-5 text-fin-pos" aria-hidden /></div>
                    <div className="mt-2 text-2xl font-semibold text-fin-pos">{t("cards.noShortfall")}</div>
                    <div className="mt-1 text-xs text-muted">{t("cards.noShortfallHint")}</div>
                  </div>; })()}
          </div> : <Callout tone="info">{t("pickCurrency")}</Callout>}
          {!sel && con && <p className="text-xs text-muted">{t("fxNote", { c: con.currency.toUpperCase(), source: con.source, rates: Object.entries(con.rates).filter(([k]) => main.some((p) => p.currency === k)).map(([k, v]) => `1 ${k.toUpperCase()} = ${Number(v).toFixed(4)}`).join(" · ") })}</p>}

          {/* ----- alerts ----- */}
          <Card>
            <CardHeader title={t("alerts.title")} description={crit.length ? t("alerts.critical", { n: crit.length }) : t("alerts.none")} />
            <ul className="divide-y divide-line">
              {inCur(data.alerts.map((a) => ({ ...a, currency: a.currency ?? (cur === ALL ? "" : cur) }))).map((a) => {
                const Icon: LucideIcon = a.severity === "critical" ? AlertOctagon : a.severity === "warning" ? AlertTriangle : Info;
                return <li key={a.id} className={cn("flex gap-3 px-5 py-3", a.severity === "critical" && "bg-fin-neg/5")}>
                  <Icon className={cn("mt-0.5 size-4 shrink-0", a.severity === "critical" ? "text-fin-neg" : a.severity === "warning" ? "text-fin-warn" : "text-fin-info")} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{a.title}{a.amount != null && a.currency ? <> — <Money v={a.amount} c={a.currency} /></> : null}</p>
                    <p className="text-sm text-muted">{a.detail}</p>
                  </div>
                  {a.href && <Link href={a.href} className="shrink-0 self-center text-sm font-medium text-accent hover:underline">{t("alerts.open")}</Link>}
                </li>;
              })}
            </ul>
          </Card>

          {/* ----- A. financial summary per currency ----- */}
          <Card>
            <CardHeader title={t("summary.title")} description={t("summary.sub")} />
            <TableWrap><Table>
              <thead><tr><Th>{t("currency")}</Th><Th className="text-end">{t("summary.cash")}</Th><Th className="text-end">{t("summary.availableNow")}</Th><Th className="text-end">{t("summary.organisers")}</Th><Th className="text-end">{t("summary.other")}</Th><Th className="text-end">{t("summary.receivables")}</Th><Th className="text-end">{t("summary.remaining")}</Th><Th className="text-end">{t("summary.netProfit")}</Th><Th>{t("summary.status")}</Th></tr></thead>
              <tbody>
                {main.filter((p) => cur === ALL || p.currency === cur).map((p) => { const pr = data.profit.find((x) => x.currency === p.currency); return (
                  <Tr key={p.currency} className={cn(p.shortfall > 0 && "bg-fin-neg/5")}>
                    <Td className="font-semibold uppercase">{p.currency}</Td>
                    <Td className="text-end"><Money v={p.cash} c={p.currency} /></Td>
                    <Td className="text-end"><Money v={p.cashAvailableNow} c={p.currency} className="text-muted" /></Td>
                    <Td className="text-end"><DrillMoney v={p.organisersOwed} c={p.currency} onClick={() => setDrill({ title: `${t("summary.organisers")} · ${p.currency.toUpperCase()}`, codes: ["2000"], currency: p.currency })} /></Td>
                    <Td className="text-end"><DrillMoney v={p.otherLiabilities} c={p.currency} onClick={() => setDrill({ title: `${t("summary.other")} · ${p.currency.toUpperCase()}`, codes: ["2100", "2200", "2210", "2300", "2400", "2900"], currency: p.currency })} /></Td>
                    <Td className="text-end"><Money v={p.receivables} c={p.currency} /></Td>
                    <Td className={cn("text-end font-semibold", p.remaining < 0 ? "text-fin-neg" : "text-fin-pos")}><Money v={p.remaining} c={p.currency} /></Td>
                    <Td className="text-end">{pr ? <DrillMoney v={pr.netProfit} c={p.currency} onClick={() => setDrill({ title: `${t("summary.netProfit")} · ${p.currency.toUpperCase()}`, codes: pr.lines.map((l) => l.code), currency: p.currency })} /> : "—"}</Td>
                    <Td><StatusPill s={p.status} /></Td>
                  </Tr>); })}
                {cur === ALL && con && <Tr className="bg-surface-2 font-semibold">
                  <Td>≈ {con.currency.toUpperCase()}</Td><Td className="text-end"><Money v={con.totals.cash ?? 0} c={con.currency} /></Td><Td className="text-end"><Money v={con.totals.cashAvailableNow ?? 0} c={con.currency} /></Td>
                  <Td className="text-end"><Money v={con.totals.organisersOwed ?? 0} c={con.currency} /></Td><Td className="text-end"><Money v={(con.totals.liabilities ?? 0) - (con.totals.organisersOwed ?? 0)} c={con.currency} /></Td>
                  <Td className="text-end"><Money v={con.totals.receivables ?? 0} c={con.currency} /></Td><Td className="text-end"><Money v={con.totals.remaining ?? 0} c={con.currency} /></Td><Td className="text-end"><Money v={con.totals.netProfit ?? 0} c={con.currency} /></Td><Td><span className="text-xs text-muted">{t("indicative")}</span></Td>
                </Tr>}
              </tbody>
            </Table></TableWrap>
            <p className="px-5 py-3 text-xs text-muted">{t("summary.formula")}</p>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            {/* cash sources */}
            <Card>
              <CardHeader title={t("cash.title")} description={t("cash.sub")} action={<Select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-auto" aria-label={t("cash.account")}><option value="">{t("cash.allAccounts")}</option><option value="stripe">Stripe</option><option value="wise">Wise</option></Select>} />
              <TableWrap><Table>
                <thead><tr><Th>{t("cash.account")}</Th><Th className="text-end">{t("cash.amount")}</Th><Th>{t("summary.status")}</Th></tr></thead>
                <tbody>{inCur(data.cash).filter((c) => !provider || c.provider === provider).map((c) => (
                  <Tr key={c.id}><Td><div className="font-medium">{c.label} · {c.currency.toUpperCase()}</div><div className="text-xs text-muted">{c.source}{c.asOf ? ` · ${new Date(c.asOf).toLocaleString()}` : ""}{c.note ? ` · ${c.note}` : ""}</div></Td>
                    <Td className="text-end">{c.provider === "stripe" ? <DrillMoney v={c.amount} c={c.currency} onClick={() => setDrill({ title: `Stripe · ${c.currency.toUpperCase()}`, codes: ["1000"], currency: c.currency })} /> : <Money v={c.amount} c={c.currency} />}</Td>
                    <Td><StatusPill s={c.status} />{!c.availableNow && <span className="ms-1 text-xs text-muted">{t("cash.notYet")}</span>}</Td></Tr>))}
                </tbody>
              </Table></TableWrap>
            </Card>

            {/* liabilities */}
            <Card>
              <CardHeader title={t("liab.title")} description={t("liab.sub")} />
              <TableWrap><Table>
                <thead><tr><Th>{t("liab.what")}</Th><Th className="text-end">{t("liab.amount")}</Th><Th className="text-end">{t("liab.dueNow")}</Th><Th>{t("summary.status")}</Th></tr></thead>
                <tbody>{inCur(data.liabilities).map((l) => (
                  <Tr key={`${l.key}-${l.currency}`}><Td><div className="font-medium">{t(`liab.k.${l.key}`)} · {l.currency.toUpperCase()}</div><div className="text-xs text-muted">{t("liab.accounts", { codes: l.accountCodes.join(", ") })}</div></Td>
                    <Td className="text-end"><DrillMoney v={l.amount} c={l.currency} onClick={() => setDrill({ title: `${t(`liab.k.${l.key}`)} · ${l.currency.toUpperCase()}`, codes: l.accountCodes, currency: l.currency })} /></Td>
                    <Td className="text-end"><Money v={l.dueNow} c={l.currency} className="text-muted" /></Td><Td><StatusPill s={l.status} /></Td></Tr>))}
                  {inCur(data.receivables).map((x) => <Tr key={`r-${x.key}-${x.currency}`}><Td><div className="font-medium">{t(`liab.r.${x.key}`)} · {x.currency.toUpperCase()}</div><div className="text-xs text-muted">{t("liab.receivable")}</div></Td><Td className="text-end text-fin-pos"><Money v={x.amount} c={x.currency} /></Td><Td /><Td><StatusPill s="VERIFIED" /></Td></Tr>)}
                </tbody>
              </Table></TableWrap>
            </Card>
          </div>

          {/* ----- B. organiser settlements ----- */}
          <Card>
            <CardHeader title={t("org.title")} description={t("org.sub")} action={<div className="flex flex-wrap gap-2">
              <Select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)} className="w-auto" aria-label={t("org.organiser")}><option value="">{t("org.allOrganisers")}</option>{orgs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-auto" aria-label={t("org.status")}><option value="">{t("org.allStatuses")}</option>{["NOT_SETTLED", "PARTIALLY_PAID", "FULLY_PAID", "OVERPAID", "ORGANISER_OWES", "NOTHING_DUE"].map((s) => <option key={s} value={s}>{t(`org.s.${s}`)}</option>)}</Select>
            </div>} />
            <TableWrap><Table>
              <thead><tr><Th>{t("org.organiser")}</Th><Th className="text-end">{t("org.sales")}</Th><Th className="text-end">{t("org.share")}</Th><Th className="text-end">{t("org.deductions")}</Th><Th className="text-end">{t("org.due")}</Th><Th className="text-end">{t("org.paid")}</Th><Th className="text-end">{t("org.outstanding")}</Th><Th className="text-end">{t("org.dueNow")}</Th><Th>{t("org.status")}</Th></tr></thead>
              <tbody>{settlements.map((s) => (
                <Tr key={`${s.organiserId}-${s.currency}`} className="cursor-pointer" onClick={() => setDrill({ title: `${s.organiserName} · ${s.currency.toUpperCase()}`, codes: ["2000"], currency: s.currency, organiserId: s.organiserId, settlement: s })}>
                  <Td><div className="font-medium text-accent">{s.organiserName}</div><div className="text-xs text-muted">{s.currency.toUpperCase()} · {t("org.events", { n: s.events })}{s.lastPayment ? ` · ${t("org.last", { d: s.lastPayment })}` : ""}</div></Td>
                  <Td className="text-end"><Money v={s.netSales} c={s.currency} /></Td>
                  <Td className="text-end"><Money v={s.organiserShare} c={s.currency} /></Td>
                  <Td className="text-end"><Money v={s.deductions} c={s.currency} className="text-muted" /></Td>
                  <Td className="text-end"><Money v={s.due} c={s.currency} /></Td>
                  <Td className="text-end"><Money v={s.paid} c={s.currency} /></Td>
                  <Td className={cn("text-end font-semibold", s.remaining > 0 ? "text-fin-warn" : s.remaining < 0 ? "text-fin-info" : "")}><Money v={s.remaining} c={s.currency} /></Td>
                  <Td className="text-end"><Money v={s.dueNow} c={s.currency} className="text-muted" /></Td>
                  <Td><span className="whitespace-nowrap text-xs font-medium">{t(`org.s.${s.status}`)}</span></Td>
                </Tr>))}
                {!settlements.length && <Tr><Td colSpan={9} className="text-center text-muted">{t("org.none")}</Td></Tr>}
              </tbody>
            </Table></TableWrap>
            <p className="px-5 py-3 text-xs text-muted">{t("org.note")}</p>
          </Card>

          {/* ----- D. cash flow ----- */}
          <Card>
            <CardHeader title={t("flow.title")} description={t("flow.sub")} />
            <TableWrap><Table>
              <thead><tr><Th>{t("flow.account")}</Th><Th className="text-end">{t("flow.opening")}</Th><Th className="text-end">{t("flow.in")}</Th><Th className="text-end">{t("flow.out")}</Th><Th className="text-end">{t("flow.closing")}</Th><Th className="text-end">{t("flow.real")}</Th><Th>{t("summary.status")}</Th></tr></thead>
              <tbody>{inCur(data.cashFlow).filter((f) => main.some((p) => p.currency === f.currency)).map((f) => {
                const rec = data.reconciliation.find((x) => x.currency === f.currency);
                const real = f.account === "stripe" ? rec?.stripeReal : rec?.wiseReal;
                return <Tr key={`${f.account}-${f.currency}`}>
                  <Td><div className="font-medium">{t(`flow.a.${f.account}`)} · {f.currency.toUpperCase()}</div><div className="text-xs text-muted">{f.byType.slice(0, 4).map((x) => `${t.has(`flow.t.${x.type}`) ? t(`flow.t.${x.type}`) : x.type}`).join(" · ")}</div></Td>
                  <Td className="text-end"><Money v={f.opening} c={f.currency} /></Td>
                  <Td className="text-end text-fin-pos"><Money v={f.inflows} c={f.currency} /></Td>
                  <Td className="text-end text-fin-neg"><Money v={-f.outflows} c={f.currency} /></Td>
                  <Td className="text-end font-semibold"><DrillMoney v={f.closing} c={f.currency} onClick={() => setDrill({ title: `${t(`flow.a.${f.account}`)} · ${f.currency.toUpperCase()}`, codes: f.account === "stripe" ? ["1000"] : ["1010", "1020", "1030"], currency: f.currency })} /></Td>
                  <Td className="text-end">{real != null ? <Money v={real} c={f.currency} className={cn(real !== f.closing && "text-fin-warn")} /> : "—"}</Td>
                  <Td><StatusPill s={f.status} /></Td>
                </Tr>; })}
              </tbody>
            </Table></TableWrap>
            <div className="grid gap-4 border-t border-line p-5 text-sm sm:grid-cols-3">
              {(sel ? [sel] : main).map((p) => <div key={p.currency} className="rounded-xl border border-line p-3">
                <p className="text-xs font-semibold uppercase text-muted">{t("flow.projection")} · {p.currency.toUpperCase()}</p>
                <dl className="mt-2 space-y-1">
                  <div className="flex justify-between gap-2"><dt>{t("flow.cashNow")}</dt><dd><Money v={p.cash} c={p.currency} /></dd></div>
                  <div className="flex justify-between gap-2"><dt>{t("flow.upcoming")}</dt><dd><Money v={-p.liabilities} c={p.currency} /></dd></div>
                  <div className="flex justify-between gap-2"><dt>{t("flow.expected")}</dt><dd><Money v={p.receivables} c={p.currency} /></dd></div>
                  <div className="flex justify-between gap-2 border-t border-line pt-1 font-semibold"><dt>{t("flow.projected")}</dt><dd className={p.remaining + p.receivables < 0 ? "text-fin-neg" : "text-fin-pos"}><Money v={p.remaining + p.receivables} c={p.currency} /></dd></div>
                </dl>
              </div>)}
            </div>
            <p className="px-5 pb-4 text-xs text-muted">{t("flow.note")}</p>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            {/* profit */}
            <Card>
              <CardHeader title={t("profit.title")} description={t("profit.sub")} />
              <TableWrap><Table>
                <thead><tr><Th>{t("currency")}</Th><Th className="text-end">{t("profit.revenue")}</Th><Th className="text-end">{t("profit.direct")}</Th><Th className="text-end">{t("profit.gross")}</Th><Th className="text-end">{t("profit.opex")}</Th><Th className="text-end">{t("profit.net")}</Th></tr></thead>
                <tbody>{inCur(data.profit).map((p) => (
                  <Tr key={p.currency}><Td className="font-semibold uppercase">{p.currency}</Td>
                    <Td className="text-end"><DrillMoney v={p.revenue} c={p.currency} onClick={() => setDrill({ title: `${t("profit.revenue")} · ${p.currency.toUpperCase()}`, codes: p.lines.filter((l) => l.type === "REVENUE").map((l) => l.code), currency: p.currency })} /></Td>
                    <Td className="text-end"><Money v={-p.directCosts} c={p.currency} /></Td><Td className="text-end"><Money v={p.grossProfit} c={p.currency} /></Td>
                    <Td className="text-end"><DrillMoney v={-p.operatingExpenses} c={p.currency} onClick={() => setDrill({ title: `${t("profit.opex")} · ${p.currency.toUpperCase()}`, codes: p.lines.filter((l) => l.type === "EXPENSE" && l.code >= "6000").map((l) => l.code), currency: p.currency })} /></Td>
                    <Td className={cn("text-end font-semibold", p.netProfit < 0 ? "text-fin-neg" : "text-fin-pos")}><Money v={p.netProfit} c={p.currency} /></Td></Tr>))}
                </tbody>
              </Table></TableWrap>
              <p className="px-5 py-3 text-xs text-muted">{t("profit.note")}</p>
            </Card>

            {/* C. inventory + reconciliation */}
            <Card>
              <CardHeader title={t("inv.title")} />
              <div className="space-y-4 p-5 text-sm">
                <Callout tone="info" icon={<Boxes className="size-4" aria-hidden />}>{data.inventory.reason}</Callout>
                <h3 className="font-semibold">{t("recon.title")}</h3>
                <TableWrap><Table>
                  <thead><tr><Th>{t("currency")}</Th><Th className="text-end">{t("recon.stripeBooks")}</Th><Th className="text-end">{t("recon.stripeReal")}</Th><Th className="text-end">{t("recon.diff")}</Th></tr></thead>
                  <tbody>{inCur(data.reconciliation).filter((x) => x.stripeBooks || x.stripeReal).map((x) => (
                    <Tr key={x.currency}><Td className="font-semibold uppercase">{x.currency}</Td><Td className="text-end"><Money v={x.stripeBooks} c={x.currency} /></Td><Td className="text-end"><Money v={x.stripeReal} c={x.currency} /></Td>
                      <Td className={cn("text-end font-semibold", x.stripeReal === x.stripeBooks ? "text-fin-pos" : "text-fin-neg")}>{x.stripeReal === x.stripeBooks ? "✓ 0" : <Money v={x.stripeReal - x.stripeBooks} c={x.currency} />}</Td></Tr>))}
                  </tbody>
                </Table></TableWrap>
              </div>
            </Card>
          </div>
        </>}

      <DrillModal drill={drill} range={r} onClose={() => setDrill(null)} />
      <AccountantWidget context={{ from: r.from ?? null, to: r.to ?? null, currency: cur === ALL ? null : cur }} />
    </div>
  );
}

type Line = { entryId: string; seq: number; date: string; type: string; description: string; reference: string | null; debit: number; credit: number; code: string; status: string };
type Payment = { id: string; date: string; amount: number; currency: string; method: string; reference: string | null; status: string; eventName: string | null; voidReason: string | null };

function DrillModal({ drill, range, onClose }: { drill: Drill; range: { from?: string; to?: string }; onClose: () => void }) {
  const t = useTranslations("accounting.position");
  const { q } = useMode();
  const [type, setType] = useState("");
  const lines = useApi<{ items: Line[] }>(drill ? q(`/api/accounting/position/lines?codes=${drill.codes.join(",")}&currency=${drill.currency}${drill.organiserId ? `&organiserId=${drill.organiserId}` : ""}${drill.settlement ? "" : rangeQuery(range)}`) : null);
  const pays = useApi<{ items: Payment[] }>(drill?.settlement ? q(`/api/accounting/position/payments?organiserId=${drill.settlement.organiserId}&currency=${drill.currency}`) : null);
  const items = (lines.data?.items ?? []).filter((l) => !type || l.type === type);
  const types = [...new Set((lines.data?.items ?? []).map((l) => l.type))].sort();
  const s = drill?.settlement;
  return (
    <Modal open={!!drill} onClose={() => { setType(""); onClose(); }} title={drill?.title ?? ""} description={t("drill.sub")} size="xl">
      {drill && <div className="space-y-5">
        {s && <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {([["org.sales", s.grossSales], ["org.refunds", -s.refunds], ["org.fees", -s.bookingFees], ["org.recharged", -s.feesRecharged], ["org.share", s.organiserShare], ["org.deductions", -s.deductions], ["org.due", s.due], ["org.paid", -s.paid]] as const).map(([k, v]) =>
              <div key={k} className="rounded-xl border border-line p-3"><dt className="text-xs text-muted">{t(k)}</dt><dd className="font-semibold"><Money v={v} c={s.currency} /></dd></div>)}
            <div className="col-span-2 rounded-xl border-2 border-fin-warn/50 p-3 sm:col-span-4"><dt className="text-xs text-muted">{t("org.outstanding")}</dt><dd className="text-xl font-semibold"><Money v={s.remaining} c={s.currency} /> <span className="text-sm font-normal text-muted">({t("org.dueNow")} <Money v={s.dueNow} c={s.currency} />, {t("org.later")} <Money v={s.dueLater} c={s.currency} />)</span></dd></div>
          </dl>
          {s.eventsOwing.length > 0 && <Callout tone="info">{t("org.owing", { list: s.eventsOwing.map((e) => `${e.eventName} (${(e.amount / 100).toFixed(2)})`).join(", ") })}</Callout>}
          <div className="flex items-center justify-between"><h3 className="font-semibold">{t("drill.payments")}</h3><Link href={`/accounting/organisers/${s.organiserId}?tab=payments`} className="text-sm text-accent hover:underline">{t("drill.openOrganiser")}</Link></div>
          <TableWrap><Table>
            <thead><tr><Th>{t("drill.date")}</Th><Th>{t("drill.ref")}</Th><Th>{t("drill.event")}</Th><Th className="text-end">{t("cash.amount")}</Th><Th>{t("summary.status")}</Th></tr></thead>
            <tbody>{(pays.data?.items ?? []).map((p) => <Tr key={p.id} className={cn(p.status === "VOIDED" && "opacity-60")}>
              <Td className="whitespace-nowrap">{p.date}</Td><Td><div className="max-w-56 truncate text-xs">{p.method} · {p.reference ?? "—"}</div></Td><Td className="text-xs">{p.eventName ?? t("drill.allEvents")}</Td>
              <Td className={cn("text-end", p.status === "VOIDED" && "line-through")}><Money v={p.amount} c={p.currency} /></Td><Td className="text-xs">{p.status}{p.voidReason ? ` — ${p.voidReason}` : ""}</Td></Tr>)}
            </tbody>
          </Table></TableWrap>
        </>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{t("drill.lines", { codes: drill.codes.join(", ") })}</h3>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto" aria-label={t("drill.type")}><option value="">{t("drill.allTypes")}</option>{types.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
        </div>
        {lines.loading ? <Skeleton className="h-40" /> : <TableWrap><Table>
          <thead><tr><Th>{t("drill.date")}</Th><Th>{t("drill.entry")}</Th><Th>{t("drill.description")}</Th><Th className="text-end">{t("drill.debit")}</Th><Th className="text-end">{t("drill.credit")}</Th></tr></thead>
          <tbody>{items.map((l, i) => <Tr key={`${l.entryId}-${l.code}-${i}`} className={cn(l.status === "REVERSED" && "opacity-60")}>
            <Td className="whitespace-nowrap">{l.date}</Td><Td className="whitespace-nowrap text-xs">#{l.seq} · {l.type} · {l.code}</Td>
            <Td><div className="max-w-md truncate text-xs">{l.description}{l.reference ? ` — ${l.reference}` : ""}{l.status === "REVERSED" ? ` (${t("drill.reversed")})` : ""}</div></Td>
            <Td className="text-end">{l.debit ? <Money v={l.debit} c={drill.currency} /> : ""}</Td><Td className="text-end">{l.credit ? <Money v={l.credit} c={drill.currency} /> : ""}</Td></Tr>)}
            {items.length > 0 && <Tr className="bg-surface-2 font-semibold"><Td colSpan={3}>{t("drill.total", { n: items.length })}</Td>
              <Td className="text-end"><Money v={items.reduce((a, l) => a + l.debit, 0)} c={drill.currency} /></Td><Td className="text-end"><Money v={items.reduce((a, l) => a + l.credit, 0)} c={drill.currency} /></Td></Tr>}
          </tbody>
        </Table></TableWrap>}
        {(lines.data?.items.length ?? 0) >= 1000 && <Callout tone="warn">{t("drill.capped")}</Callout>}
        <p className="flex items-center gap-1.5 text-xs text-muted"><Banknote className="size-3.5" aria-hidden />{t("drill.note")}</p>
      </div>}
    </Modal>
  );
}
