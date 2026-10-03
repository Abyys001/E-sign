"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { faCheck, faCircleCheck, faClock, faDownload, faFileArrowDown, faFileInvoiceDollar, faMagnifyingGlass, faPaperclip, faPen, faReceipt, faTrash, faTriangleExclamation, faBan } from "@fortawesome/free-solid-svg-icons";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { BillDialog, Fa, PayBillDialog, useExpenseAccounts, type BillRow } from "@/components/accounting/books";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useDebounced } from "@/lib/hooks";
import { api, errMsg, useApi } from "@/lib/api";

type Resp = { items: BillRow[]; total: number; totals: Array<{ currency: string; net: number; vat: number; total: number; unpaid: number }>; page: number; pageSize: number };

function StatusPill({ b }: { b: BillRow }) {
  const t = useTranslations("accounting.books.doc.st");
  const s = b.status === "UNPAID" && b.overdue ? "OVERDUE" : b.status;
  const m = { PAID: ["border-fin-pos/40 bg-fin-pos/12 text-fin-pos", faCircleCheck], UNPAID: ["border-fin-info/40 bg-fin-info/12 text-fin-info", faClock], OVERDUE: ["border-fin-neg/40 bg-fin-neg/12 text-fin-neg", faTriangleExclamation], VOIDED: ["border-line-strong text-muted", faBan] } as const;
  const [cls, icon] = m[s as keyof typeof m] ?? m.VOIDED;
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", cls)}><Fa icon={icon} className="text-[10px]" />{t(s)}</span>;
}

export default function InvoicesPage() {
  const t = useTranslations("accounting.books.doc");
  const toast = useToast();
  const ensure = useElevation();
  const doExport = useExport();
  const { can } = useMe();
  const { mode, q: withMode } = useMode();
  const accounts = useExpenseAccounts();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const [f, setF] = useState({ kind: "", status: "", accountId: "", q: "" });
  const [page, setPage] = useState(1);
  const [dlg, setDlg] = useState<{ kind: "BILL" | "EXPENSE"; bill?: BillRow } | null>(null);
  const [paying, setPaying] = useState<BillRow | null>(null); const [del, setDel] = useState<BillRow | null>(null); const [reason, setReason] = useState("");
  const dq = useDebounced(f.q, 300);
  const qs = `${rangeQuery(rangeFor(range.key, range))}${f.kind ? `&kind=${f.kind}` : ""}${f.status ? `&status=${f.status}` : ""}${f.accountId ? `&accountId=${f.accountId}` : ""}${dq ? `&q=${encodeURIComponent(dq)}` : ""}`;
  const { data, loading, reload } = useApi<Resp>(withMode(`/api/accounting/bills?page=${page}&pageSize=50${qs}`));
  const set = (k: keyof typeof f, v: string) => { setF((o) => ({ ...o, [k]: v })); setPage(1); };
  const manage = can("accounting.manage");
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        <Button onClick={() => doExport(ensure, withMode(`/api/accounting/bills?x=1${qs}`))}><Fa icon={faFileArrowDown} />{t("export")}</Button>
        {manage && <><Button onClick={() => setDlg({ kind: "EXPENSE" })}><Fa icon={faReceipt} />{t("newExpense")}</Button><Button variant="primary" onClick={() => setDlg({ kind: "BILL" })}><Fa icon={faFileInvoiceDollar} />{t("newBill")}</Button></>}</>} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-line-strong p-0.5 text-sm">{["", "BILL", "EXPENSE"].map((k) => <button key={k} type="button" onClick={() => set("kind", k)} className={cn("rounded-lg px-3 py-1.5", f.kind === k ? "bg-fg text-bg" : "text-muted hover:text-fg")}>{t(`kinds.${k || "ALL"}`)}</button>)}</div>
        <div className="relative min-w-52 flex-1 sm:max-w-xs"><Fa icon={faMagnifyingGlass} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xs text-muted" /><Input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <Select aria-label={t("status")} value={f.status} onChange={(e) => set("status", e.target.value)} className="w-auto"><option value="">{t("anyStatus")}</option>{["UNPAID", "OVERDUE", "PAID", "VOIDED"].map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>
        <Select aria-label={t("category")} value={f.accountId} onChange={(e) => set("accountId", e.target.value)} className="w-auto"><option value="">{t("anyCategory")}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} keys={["all", "month", "lastMonth", "year", "custom"]} />
      </div>
      {data && data.totals.length > 0 && <div className="flex flex-wrap gap-3">{data.totals.map((x) => (
        <Card key={x.currency} className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 text-sm"><span className="font-semibold uppercase">{x.currency}</span>
          <span><span className="text-muted">{t("net")}: </span><Money v={x.net} c={x.currency} /></span><span><span className="text-muted">{t("vat")}: </span><Money v={x.vat} c={x.currency} /></span>
          <span><span className="text-muted">{t("total")}: </span><Money v={x.total} c={x.currency} strong /></span><span className="text-fin-warn"><span className="text-muted">{t("unpaidTotal")}: </span><Money v={x.unpaid} c={x.currency} strong /></span></Card>))}</div>}
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          : !data?.items.length ? <EmptyState icon={<Fa icon={faFileInvoiceDollar} className="text-2xl" />} title={t("empty")} description={t("emptyDesc")} action={manage && <Button variant="primary" onClick={() => setDlg({ kind: "BILL" })}><Fa icon={faFileInvoiceDollar} />{t("newBill")}</Button>} /> : <>
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr><Th>{t("date")}</Th><Th>{t("supplier")}</Th><Th>{t("category")}</Th><Th className="text-end">{t("net")}</Th><Th className="text-end">{t("vat")}</Th><Th className="text-end">{t("total")}</Th><Th>{t("status")}</Th><Th>{t("file")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((b) => <Tr key={b.id} className={b.status === "VOIDED" ? "text-muted" : ""}>
              <Td className="whitespace-nowrap">{b.invoiceDate}{b.dueDate && b.status === "UNPAID" && <span className={cn("block text-xs", b.overdue ? "text-fin-neg" : "text-muted")}>{t("due")} {b.dueDate}</span>}</Td>
              <Td className="min-w-48"><span className="flex items-center gap-2 font-medium"><Fa icon={b.kind === "BILL" ? faFileInvoiceDollar : faReceipt} className="text-xs text-muted" />{b.supplierName}</span>
                <span className="block text-xs text-muted">{[b.invoiceNumber && `#${b.invoiceNumber}`, b.eventName, b.description].filter(Boolean).join(" · ")}</span>{b.voidReason && <span className="block text-xs">{t("deleted")}: {b.voidReason}</span>}</Td>
              <Td className="whitespace-nowrap">{b.accountName}</Td>
              <Td className="text-end"><Money v={b.netAmount} c={b.currency} /></Td><Td className="text-end text-muted"><Money v={b.vatAmount} c={b.currency} /></Td><Td className="text-end"><Money v={b.totalAmount} c={b.currency} strong /></Td>
              <Td><StatusPill b={b} />{b.paidDate && b.status === "PAID" && <span className="block text-xs text-muted">{b.paidDate} · {t(`from.${b.paidFrom ?? "BANK"}`)}</span>}</Td>
              <Td>{b.hasFile ? <a href={`/api/accounting/bills/${b.id}/file`} className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4" title={b.fileName ?? ""}><Fa icon={faDownload} className="text-xs" />{t("download")}</a> : <span className="inline-flex items-center gap-1 text-muted"><Fa icon={faPaperclip} className="text-xs" />—</span>}</Td>
              <Td className="text-end">{manage && b.status !== "VOIDED" && <div className="flex justify-end gap-1">
                {b.status === "UNPAID" && <Button size="sm" onClick={() => setPaying(b)}><Fa icon={faCheck} className="text-xs" />{t("markPaid")}</Button>}
                <Button size="sm" variant="ghost" aria-label={t("edit")} onClick={() => setDlg({ kind: b.kind, bill: b })}><Fa icon={faPen} className="text-xs" /></Button>
                <Button size="sm" variant="ghost" aria-label={t("delete")} onClick={async () => { if (await ensure()) { setReason(""); setDel(b); } }}><Fa icon={faTrash} className="text-xs" /></Button></div>}</Td>
            </Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {dlg && <BillDialog kind={dlg.kind} bill={dlg.bill} mode={mode} onClose={() => setDlg(null)} onSaved={() => void reload()} />}
      {paying && <PayBillDialog bill={paying} onClose={() => setPaying(null)} onSaved={() => void reload()} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("deleteTitle")} description={t("deleteDesc")} confirmLabel={t("delete")}
        onConfirm={async () => { try { await api(`/api/accounting/bills/${del!.id}/void`, { json: { reason } }); toast("ok", t("deletedToast")); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("reason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}
