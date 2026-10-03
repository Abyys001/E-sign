"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, Ban, Search, ShieldAlert, Undo2 } from "lucide-react";
import { Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey } from "@/components/accounting/kit";
import { cardLabel, ChargePill, RiskLabel, type Charge } from "@/components/accounting/payments";
import { StripeNav } from "../nav";
import { Card, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { fmtDate, useApi } from "@/lib/api";

type Row = Charge & { id: string; btId: string | null; eventName: string | null; refundIssues: number };
type Resp = { items: Row[]; total: number; page: number; pageSize: number; counts: { failed: number; disputed: number; refunded: number; risky: number } };
const FILTERS = ["", "issues", "failed", "refunded", "partially_refunded", "disputed", "succeeded"] as const;

/** Every Stripe payment, including declined ones (which never reach the ledger), with the reason and risk. */
export default function PaymentsPage() {
  const t = useTranslations("accounting.pay.list");
  const locale = useLocale();
  const { q: withMode } = useMode();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>(""); const [q, setQ] = useState(""); const [page, setPage] = useState(1);
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const dq = useDebounced(q, 300);
  const { data, loading } = useApi<Resp>(withMode(`/api/accounting/stripe/charges?page=${page}&pageSize=50${status ? `&status=${status}` : ""}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${rangeQuery(rangeFor(range.key, range))}`));
  const counts = data?.counts;
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <StripeNav />
      {counts && (counts.failed + counts.disputed + counts.risky > 0) && <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {counts.failed > 0 && <button type="button" onClick={() => { setStatus("failed"); setPage(1); }} className="inline-flex items-center gap-1.5 rounded-full border border-fin-neg/40 bg-fin-neg/10 px-3 py-1 text-fin-neg"><Ban className="size-3.5" aria-hidden />{t("nFailed", { n: counts.failed })}</button>}
        {counts.disputed > 0 && <button type="button" onClick={() => { setStatus("disputed"); setPage(1); }} className="inline-flex items-center gap-1.5 rounded-full border border-fin-neg/40 bg-fin-neg/10 px-3 py-1 text-fin-neg"><ShieldAlert className="size-3.5" aria-hidden />{t("nDisputed", { n: counts.disputed })}</button>}
        {counts.risky > 0 && <button type="button" onClick={() => { setStatus("issues"); setPage(1); }} className="inline-flex items-center gap-1.5 rounded-full border border-fin-warn/40 bg-fin-warn/10 px-3 py-1 text-fin-warn"><AlertTriangle className="size-3.5" aria-hidden />{t("nRisky", { n: counts.risky })}</button>}
        {counts.refunded > 0 && <button type="button" onClick={() => { setStatus("refunded"); setPage(1); }} className="inline-flex items-center gap-1.5 rounded-full border border-fin-warn/40 bg-fin-warn/10 px-3 py-1 text-fin-warn"><Undo2 className="size-3.5" aria-hidden />{t("nRefunded", { n: counts.refunded })}</button>}
      </div>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-xl border border-line-strong p-0.5 text-sm">{FILTERS.map((k) => <button key={k} type="button" onClick={() => { setStatus(k); setPage(1); }} className={cn("rounded-lg px-3 py-1.5", status === k ? "bg-fg text-bg" : "text-muted hover:text-fg")}>{t(`f.${k || "all"}`)}</button>)}</div>
        <div className="relative min-w-56 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} keys={["all", "today", "week", "month", "lastMonth", "custom"]} />
      </div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr><Th>{t("date")}</Th><Th>{t("customer")}</Th><Th>{t("order")}</Th><Th className="text-end">{t("amount")}</Th><Th className="text-end">{t("refunded")}</Th><Th>{t("card")}</Th><Th>{t("risk")}</Th><Th>{t("status")}</Th></tr></thead>
            <tbody>{data.items.map((c) => <Tr key={c.id}>
              <Td className="whitespace-nowrap">{fmtDate(c.stripeCreatedAt, locale, { dateStyle: "short", timeStyle: "short" })}</Td>
              <Td className="min-w-40"><span className="font-medium">{c.customerName ?? "—"}</span><span className="block text-xs text-muted">{c.customerEmail}</span></Td>
              <Td className="max-w-72">{c.btId ? <Link href={`/accounting/transactions/${c.btId}`} className="block truncate underline-offset-4 hover:underline" title={c.description ?? ""}>{c.eventName ?? c.description ?? c.chargeId}</Link> : <span className="block truncate" title={c.description ?? ""}>{c.description ?? c.chargeId}</span>}<code className="text-xs text-muted">{c.chargeId}</code></Td>
              <Td className="text-end"><Money v={c.amount} c={c.currency} strong /></Td>
              <Td className="text-end">{c.amountRefunded ? <Money v={-c.amountRefunded} c={c.currency} className="text-fin-warn" /> : <span className="text-muted">—</span>}</Td>
              <Td className="whitespace-nowrap">{cardLabel(c.paymentMethod)}{c.paymentMethod?.country && <span className="text-muted"> · {c.paymentMethod.country}</span>}</Td>
              <Td><RiskLabel o={c.outcome} /></Td>
              <Td><ChargePill c={c} />{c.status === "failed" && <span className="block max-w-56 text-xs text-fin-neg">{c.failureMessage ?? c.outcome?.sellerMessage}{c.failureCode ? ` (${c.failureCode})` : ""}</span>}{c.refundIssues > 0 && <span className="block text-xs text-fin-neg">{t("refundIssue")}</span>}</Td>
            </Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
    </div>
  );
}
