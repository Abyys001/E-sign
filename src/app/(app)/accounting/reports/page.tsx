"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Badge, Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { Button, LinkButton } from "@/components/ui/button";
import { AccountantPanel } from "@/components/accounting/accountant";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/components/ui/cn";
import { fmtDate, useApi } from "@/lib/api";

type Rep = "sales" | "event-profit" | "reconciliation";
type Col = { k: string; money?: boolean; kind?: "date" | "status" | "code" };
const COLS: Record<Rep, Col[]> = {
  sales: [{ k: "date", kind: "date" }, { k: "eventName" }, { k: "eventCode", kind: "code" }, { k: "organiserName" }, { k: "order", kind: "code" }, { k: "stripePayment", kind: "code" }, { k: "gross", money: true }, { k: "refunded", money: true }, { k: "stripeFee", money: true }, { k: "net", money: true }, { k: "commission", money: true }, { k: "status", kind: "status" }],
  "event-profit": [{ k: "eventName" }, { k: "eventCode", kind: "code" }, { k: "organiserName" }, { k: "grossSales", money: true }, { k: "refunds", money: true }, { k: "chargebacks", money: true }, { k: "stripeFees", money: true }, { k: "commission", money: true }, { k: "otherCosts", money: true }, { k: "organiserPayable", money: true }, { k: "organiserOutstanding", money: true }, { k: "bilitProfit", money: true }],
  reconciliation: [{ k: "stripeCreatedAt", kind: "date" }, { k: "balanceTransactionId", kind: "code" }, { k: "type" }, { k: "amount", money: true }, { k: "fee", money: true }, { k: "net", money: true }, { k: "eventName" }, { k: "organiserName" }, { k: "reconciliationStatus", kind: "status" }],
};

export default function ReportsPage() {
  const t = useTranslations("accounting.reports");
  const locale = useLocale();
  const { q } = useMode();
  const ensure = useElevation();
  const exp = useExport();
  const [rep, setRep] = useState<Rep>("sales"); const [page, setPage] = useState(1);
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "month" });
  const rq = rangeQuery(rangeFor(range.key, range));
  const { data, loading } = useApi<{ items: Array<Record<string, unknown>>; hasMore: boolean }>(q(`/api/accounting/reports/${rep}?page=${page}&pageSize=50${rq}`));
  const cell = (r: Record<string, unknown>, c: Col) => {
    const v = r[c.k];
    if (c.money) return <Money v={v as number} c={r.currency as string} />;
    if (c.kind === "date") return v ? fmtDate(v as string, locale, { dateStyle: "short", timeStyle: "short" }) : "—";
    if (c.kind === "status") return <Badge s={v as string} />;
    if (c.kind === "code") return v ? <code className="text-xs">{String(v)}</code> : "—";
    return v == null ? "—" : String(v);
  };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<><RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} /><Button onClick={() => exp(ensure, q(`/api/accounting/reports/${rep}?x=1${rq}`))}><Download className="size-4" aria-hidden />{t("csv")}</Button></>} />
      <AccountantPanel />
      <div role="tablist" aria-label={t("title")} className="mb-4 flex flex-wrap gap-2">
        {(["sales", "event-profit", "reconciliation"] as Rep[]).map((r) => <button key={r} role="tab" type="button" aria-selected={rep === r} onClick={() => { setRep(r); setPage(1); }} className={cn("rounded-xl border px-3.5 py-2 text-sm transition", rep === r ? "border-fg bg-fg text-bg" : "border-line-strong hover:bg-surface-2")}>{t(`r.${r}`)}</button>)}
      </div>
      <Card><CardHeader title={t(`r.${rep}`)} description={t(`d.${rep}`)} />
        {loading && !data ? <Skeleton className="m-4 h-32" /> : !data?.items.length ? <EmptyState title={t("empty")} /> : <>
          <TableWrap><Table><thead><tr>{COLS[rep].map((c) => <Th key={c.k} className={c.money ? "text-end" : ""}>{t(`c.${c.k}`)}</Th>)}{rep !== "reconciliation" && <Th>{t("c.currency")}</Th>}</tr></thead>
            <tbody>{data.items.map((r, i) => <Tr key={String(r.id ?? r.eventId ?? i) + String(r.currency)}>{COLS[rep].map((c) => <Td key={c.k} className={c.money ? "text-end" : "max-w-64 truncate"}>{cell(r, c)}</Td>)}{rep !== "reconciliation" && <Td className="uppercase">{String(r.currency)}</Td>}</Tr>)}</tbody></Table></TableWrap>
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("prev")}</Button><span className="num text-sm text-muted">{page}</span><Button size="sm" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>{t("next")}</Button></div></>}
      </Card>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-5"><p className="font-medium">{t("more.statement")}</p><p className="mt-1 text-sm text-muted">{t("more.statementDesc")}</p><LinkButton href="/accounting/organisers" size="sm" className="mt-3">{t("more.open")}</LinkButton></Card>
        <Card className="p-5"><p className="font-medium">{t("more.payouts")}</p><p className="mt-1 text-sm text-muted">{t("more.payoutsDesc")}</p><LinkButton href="/accounting/stripe/payouts" size="sm" className="mt-3">{t("more.open")}</LinkButton></Card>
        <Card className="p-5"><p className="font-medium">{t("more.ledger")}</p><p className="mt-1 text-sm text-muted">{t("more.ledgerDesc")}</p><LinkButton href="/accounting/ledger" size="sm" className="mt-3">{t("more.open")}</LinkButton></Card>
      </div>
    </div>
  );
}
