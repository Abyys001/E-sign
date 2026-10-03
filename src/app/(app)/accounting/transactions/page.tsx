"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Download, Search } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Badge, Money, RangePicker, rangeFor, rangeQuery, Reason, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { fmtDate, useApi } from "@/lib/api";

export type TxRow = { id: string; balanceTransactionId: string; type: string; kind: string; amount: number; fee: number; net: number; currency: string; description: string | null; stripeCreatedAt: string; eventCode: string | null; eventId: string | null; eventName: string | null; organiserName: string | null; customerName: string | null; reconciliationStatus: string; matchReason: string | null; commissionAmount: number | null };
const KINDS = ["SALE", "REFUND", "DISPUTE", "DISPUTE_REVERSAL", "PAYOUT", "PAYOUT_REVERSAL", "STRIPE_FEE", "OTHER"];
const STATUSES = ["MATCHED", "UNMATCHED", "PARTIAL", "DUPLICATE", "REFUND", "DISPUTE", "MANUAL_REVIEW", "ERROR"];

export default function Page() { return <Suspense><TransactionsPage /></Suspense>; }

function TransactionsPage() {
  const t = useTranslations("accounting.tx");
  const tk = useTranslations("accounting.kind");
  const ts = useTranslations("accounting.status");
  const locale = useLocale();
  const { q } = useMode();
  const ensure = useElevation();
  const exp = useExport();
  const sp = useSearchParams();
  const scope = `${sp.get("eventId") ? `&eventId=${sp.get("eventId")}` : ""}${sp.get("organiserId") ? `&organiserId=${sp.get("organiserId")}` : ""}${sp.get("payoutId") ? `&payoutId=${encodeURIComponent(sp.get("payoutId")!)}` : ""}`;
  const [kind, setKind] = useState(sp.get("kind") ?? ""); const [status, setStatus] = useState(sp.get("status") ?? ""); const [text, setText] = useState(""); const [page, setPage] = useState(1);
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const dq = useDebounced(text, 350);
  const filters = `${scope}${kind ? `&kind=${kind}` : ""}${status ? `&status=${status}` : ""}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${rangeQuery(rangeFor(range.key, range))}`;
  const { data, loading } = useApi<{ items: TxRow[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/transactions?page=${page}&pageSize=50${filters}`));
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<Button onClick={() => exp(ensure, q(`/api/accounting/transactions?x=1${filters}`))}><Download className="size-4" aria-hidden />{t("export")}</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <Select aria-label={t("kind")} value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} className="w-auto"><option value="">{t("allKinds")}</option>{KINDS.map((k) => <option key={k} value={k}>{tk(k)}</option>)}</Select>
        <Select aria-label={t("status")} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto"><option value="">{t("allStatuses")}</option>{STATUSES.map((s) => <option key={s} value={s}>{ts(s)}</option>)}</Select>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
      </div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table>
            <thead><tr><Th>{t("date")}</Th><Th>{t("kind")}</Th><Th>{t("description")}</Th><Th>{t("eventCode")}</Th><Th>{t("event")}</Th><Th className="text-end">{t("gross")}</Th><Th className="text-end">{t("fee")}</Th><Th className="text-end">{t("net")}</Th><Th>{t("status")}</Th></tr></thead>
            <tbody>{data.items.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap text-muted">{fmtDate(r.stripeCreatedAt, locale)}</Td>
                <Td>{tk(r.kind)}</Td>
                <Td className="max-w-72"><Link href={`/accounting/transactions/${r.id}`} className="block truncate font-medium underline-offset-4 hover:underline">{r.description || r.balanceTransactionId}</Link>{r.customerName && <span className="block truncate text-xs text-muted">{r.customerName}</span>}</Td>
                <Td>{r.eventCode ? <code className="whitespace-nowrap text-xs font-semibold">{r.eventCode}</code> : <span className="text-muted">—</span>}</Td>
                <Td>{r.eventName ?? <span className="text-muted">{t("noEvent")}</span>}</Td>
                <Td className="text-end"><Money v={r.amount} c={r.currency} /></Td>
                <Td className="text-end text-muted"><Money v={r.fee} c={r.currency} /></Td>
                <Td className="text-end"><Money v={r.net} c={r.currency} strong /></Td>
                <Td><Badge s={r.reconciliationStatus} /><div><Reason r={r.matchReason} /></div></Td>
              </Tr>))}</tbody>
          </Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
    </div>
  );
}
