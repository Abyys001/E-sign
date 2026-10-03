"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { faArrowTrendDown, faArrowTrendUp, faCoins, faFileInvoiceDollar, faMoneyCheckDollar, faPercent, faReceipt, faScaleBalanced, faTriangleExclamation, faUserTie } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { useMe } from "@/components/app/me";
import { Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey } from "@/components/accounting/kit";
import { accountIcon, BillDialog, Fa } from "@/components/accounting/books";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { useApi } from "@/lib/api";

type Cur = { currency: string; lines: Array<{ code: string; name: string; type: string; key: string | null; amount: number }>; revenue: number; expenses: number; netProfit: number; unpaidBills: number; overdueBills: number; unpaidCount: number; overdueCount: number; inputVat: number; payroll: { gross: number; net: number; employer: number; payslips: number } };
const tone = { pos: "border-fin-pos/30 bg-fin-pos/10 text-fin-pos", neg: "border-fin-neg/30 bg-fin-neg/10 text-fin-neg", warn: "border-fin-warn/30 bg-fin-warn/10 text-fin-warn", info: "border-fin-info/30 bg-fin-info/10 text-fin-info", bal: "border-fin-bal/30 bg-fin-bal/10 text-fin-bal" };

function Tile({ icon, label, v, c, t, hint }: { icon: IconDefinition; label: string; v: number; c: string; t: keyof typeof tone; hint?: React.ReactNode }) {
  return (
    <div className={cn("rounded-card border p-5 shadow-card", tone[t])}>
      <div className="flex items-center justify-between text-sm font-medium text-fg/80"><span>{label}</span><span className="grid size-9 place-items-center rounded-lg bg-surface/60"><Fa icon={icon} /></span></div>
      <div className="num mt-2 text-2xl font-semibold tracking-tight"><Money v={v} c={c} /></div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export default function BooksOverview() {
  const t = useTranslations("accounting.books.overview");
  const { can } = useMe();
  const { mode, q } = useMode();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "month" });
  const [cur, setCur] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"BILL" | "EXPENSE" | null>(null);
  const { data, loading, reload } = useApi<{ currencies: Cur[] }>(q(`/api/accounting/books/overview?x=1${rangeQuery(rangeFor(range.key, range))}`));
  const c = data?.currencies.find((x) => x.currency === cur) ?? data?.currencies[0];
  const manage = can("accounting.manage");
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        {data && data.currencies.length > 1 && c && <Select aria-label={t("currency")} value={c.currency} onChange={(e) => setCur(e.target.value)} className="w-auto font-semibold uppercase">{data.currencies.map((x) => <option key={x.currency} value={x.currency}>{x.currency.toUpperCase()}</option>)}</Select>}
        <RangePicker value={range} onChange={setRange} keys={["month", "lastMonth", "year", "all", "custom"]} /></>} />
      {manage && <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setDlg("BILL")}><Fa icon={faFileInvoiceDollar} />{t("uploadInvoice")}</Button>
        <Button onClick={() => setDlg("EXPENSE")}><Fa icon={faReceipt} />{t("addExpense")}</Button>
        {can("accounting.payroll") && <LinkButton href="/accounting/books/payslips"><Fa icon={faMoneyCheckDollar} />{t("newPayslip")}</LinkButton>}
      </div>}
      {loading && !data ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div> : !c ? <Card><EmptyState title={t("empty")} description={t("emptyDesc")} /></Card> : <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Tile icon={faArrowTrendUp} label={t("revenue")} v={c.revenue} c={c.currency} t="pos" />
          <Tile icon={faArrowTrendDown} label={t("expenses")} v={c.expenses} c={c.currency} t="warn" />
          <Tile icon={faScaleBalanced} label={t("netProfit")} v={c.netProfit} c={c.currency} t={c.netProfit < 0 ? "neg" : "pos"} />
          <Tile icon={faFileInvoiceDollar} label={t("unpaid")} v={c.unpaidBills} c={c.currency} t="info" hint={t("unpaidHint", { n: c.unpaidCount })} />
          <Tile icon={faTriangleExclamation} label={t("overdue")} v={c.overdueBills} c={c.currency} t={c.overdueCount ? "neg" : "bal"} hint={t("overdueHint", { n: c.overdueCount })} />
          <Tile icon={faPercent} label={t("inputVat")} v={c.inputVat} c={c.currency} t="bal" hint={t("inputVatHint")} />
          <Tile icon={faUserTie} label={t("payrollGross")} v={c.payroll.gross} c={c.currency} t="info" hint={t("payrollHint", { n: c.payroll.payslips })} />
          <Tile icon={faCoins} label={t("payrollCost")} v={c.payroll.gross + c.payroll.employer} c={c.currency} t="warn" hint={t("payrollCostHint")} />
        </div>
        <Card><CardHeader title={t("plTitle")} description={t("plDesc", { c: c.currency.toUpperCase() })} />
          <div className="grid gap-px bg-line md:grid-cols-2">
            {(["REVENUE", "EXPENSE"] as const).map((type) => (
              <section key={type} className="bg-surface p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Fa icon={type === "REVENUE" ? faArrowTrendUp : faArrowTrendDown} className={type === "REVENUE" ? "text-fin-pos" : "text-fin-warn"} />{t(type === "REVENUE" ? "income" : "costs")}</h3>
                <ul className="divide-y divide-line text-sm">{c.lines.filter((l) => l.type === type).map((l) => (
                  <li key={l.code} className="flex items-center justify-between gap-3 py-2"><span className="flex min-w-0 items-center gap-2.5"><span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-2 text-muted"><Fa icon={accountIcon(l.key)} className="text-xs" /></span><span className="truncate">{l.name}</span><code className="text-xs text-muted">{l.code}</code></span><Money v={l.amount} c={c.currency} /></li>))}
                  {!c.lines.some((l) => l.type === type) && <li className="py-2 text-muted">—</li>}
                </ul>
                <div className="mt-2 flex justify-between border-t-2 border-fg/70 pt-2 font-semibold"><span>{t(type === "REVENUE" ? "totalIncome" : "totalCosts")}</span><Money v={type === "REVENUE" ? c.revenue : c.expenses} c={c.currency} /></div>
              </section>
            ))}
          </div>
          <div className={cn("flex items-center justify-between border-t border-line px-5 py-4 text-lg font-semibold", c.netProfit < 0 ? "text-fin-neg" : "text-fin-pos")}><span>{t("netProfit")}</span><Money v={c.netProfit} c={c.currency} /></div>
        </Card>
      </>}
      {dlg && <BillDialog kind={dlg} mode={mode} onClose={() => setDlg(null)} onSaved={() => void reload()} />}
    </div>
  );
}
