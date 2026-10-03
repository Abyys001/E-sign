"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { faFileInvoice, faFilePdf, faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import { Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey } from "@/components/accounting/kit";
import { Fa } from "@/components/accounting/books";
import { Card, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { useApi } from "@/lib/api";

type Inv = { id: string; kind: string; number: string; vatInvoice: boolean; balanceTransactionRef: string; issueDate: string; currency: string; netTotal: number; vatTotal: number; grossTotal: number; status: string; eventName: string | null; customer: { name: string; company?: string | null; email?: string | null } };

/** Invoices, VAT invoices and credit notes issued to ticket buyers. */
export default function CustomerInvoicesPage() {
  const t = useTranslations("accounting.pay.inv");
  const { q: withMode } = useMode();
  const [kind, setKind] = useState(""); const [q, setQ] = useState(""); const [page, setPage] = useState(1);
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const dq = useDebounced(q, 300);
  const { data, loading } = useApi<{ items: Inv[]; total: number; page: number; pageSize: number }>(withMode(`/api/accounting/customer-invoices?page=${page}&pageSize=50${kind ? `&kind=${kind}` : ""}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${rangeQuery(rangeFor(range.key, range))}`));
  return (
    <div className="space-y-4">
      <PageHeader title={t("listTitle")} description={t("listSub")} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-line-strong p-0.5 text-sm">{["", "INVOICE", "CREDIT_NOTE"].map((k) => <button key={k} type="button" onClick={() => { setKind(k); setPage(1); }} className={cn("rounded-lg px-3 py-1.5", kind === k ? "bg-fg text-bg" : "text-muted hover:text-fg")}>{t(`filter.${k || "ALL"}`)}</button>)}</div>
        <div className="relative min-w-52 flex-1 sm:max-w-xs"><Fa icon={faMagnifyingGlass} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xs text-muted" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} keys={["all", "month", "lastMonth", "year", "custom"]} />
      </div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState icon={<Fa icon={faFileInvoice} className="text-2xl" />} title={t("listEmpty")} description={t("listEmptyDesc")} /> : <>
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr><Th>{t("number")}</Th><Th>{t("date")}</Th><Th>{t("type")}</Th><Th>{t("customer")}</Th><Th>{t("event")}</Th><Th className="text-end">{t("net")}</Th><Th className="text-end">{t("vat")}</Th><Th className="text-end">{t("total")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">PDF</span></Th></tr></thead>
            <tbody>{data.items.map((i) => <Tr key={i.id} className={i.status === "VOIDED" ? "text-muted" : ""}>
              <Td className="whitespace-nowrap font-mono text-xs"><Link href={`/accounting/transactions/${i.balanceTransactionRef}`} className={cn("underline-offset-4 hover:underline", i.status === "VOIDED" && "line-through")}>{i.number}</Link></Td>
              <Td className="whitespace-nowrap">{i.issueDate}</Td><Td>{t(`kind.${i.kind}${i.vatInvoice ? "_VAT" : ""}`)}</Td>
              <Td><span className="font-medium">{i.customer.company ?? i.customer.name}</span>{i.customer.email && <span className="block text-xs text-muted">{i.customer.email}</span>}</Td><Td>{i.eventName ?? "—"}</Td>
              <Td className="text-end"><Money v={i.kind === "CREDIT_NOTE" ? -i.netTotal : i.netTotal} c={i.currency} /></Td><Td className="text-end"><Money v={i.kind === "CREDIT_NOTE" ? -i.vatTotal : i.vatTotal} c={i.currency} /></Td><Td className="text-end"><Money v={i.kind === "CREDIT_NOTE" ? -i.grossTotal : i.grossTotal} c={i.currency} strong /></Td>
              <Td>{i.status === "VOIDED" ? t("voided") : t("issuedStatus")}</Td>
              <Td><a href={`/api/accounting/customer-invoices/${i.id}/pdf`} className="inline-flex items-center gap-1.5 hover:underline"><Fa icon={faFilePdf} className="text-fin-neg" />PDF</a></Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
    </div>
  );
}
