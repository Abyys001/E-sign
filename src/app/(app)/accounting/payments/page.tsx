"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banknote, Bot, CheckCircle2, Download, Eye, FileDown, Pencil, Trash2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, Money, useExport, useMode } from "@/components/accounting/kit";
import { PaymentEditDialog, PaymentViewDialog } from "@/components/accounting/finance";
import { PaymentDialog } from "@/components/accounting/forms";
import { PaymentAgentDialog } from "@/components/accounting/payment-agent";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Select, Textarea } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type P = { id: string; organiserId: string; organiserName: string; eventId: string | null; eventName: string | null; eventCode: string | null; amount: number; currency: string; paymentDate: string; bankReference: string | null; method: string; status: string; notes: string | null; voidReason: string | null; createdByName: string | null; createdAt: string };

export default function PaymentsPage() {
  const t = useTranslations("accounting.payments");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { mode, q } = useMode();
  const [status, setStatus] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false); const [agent, setAgent] = useState(false);
  const [voiding, setVoiding] = useState<P | null>(null); const [reason, setReason] = useState("");
  const [view, setView] = useState<string | null>(null); const [editing, setEditing] = useState<P | null>(null);
  const doExport = useExport();
  const tf = useTranslations("accounting.fin");
  const ta = useTranslations("accounting.payagent");
  const { data, loading, reload } = useApi<{ items: P[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/organiser-payments?page=${page}&pageSize=50${status ? `&status=${status}` : ""}`));
  const markPaid = async (p: P) => { try { await api(`/api/accounting/organiser-payments/${p.id}`, { method: "PATCH", json: { status: "PAID" } }); toast("ok", t("markedPaid")); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        <Select aria-label={t("status")} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto"><option value="">{t("all")}</option>{["PAID", "PENDING", "VOIDED"].map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>
        <Button onClick={() => doExport(ensure, q(`/api/accounting/organiser-payments?x=1${status ? `&status=${status}` : ""}`))}><Download className="size-4" aria-hidden />{tf("export")}</Button>
        {can("accounting.manage") && <Button onClick={() => setAgent(true)}><Bot className="size-4" aria-hidden />{ta("open")}</Button>}
        {can("accounting.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Banknote className="size-4" aria-hidden />{t("record")}</Button>}</>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("organiser")}</Th><Th>{t("event")}</Th><Th>{t("reference")}</Th><Th>{t("method")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((p) => <Tr key={p.id}>
              <Td className="whitespace-nowrap">{p.paymentDate}<span className="block text-xs text-muted">{p.createdByName} · {fmtDate(p.createdAt, locale, { dateStyle: "short" })}</span></Td>
              <Td><Link href={`/accounting/organisers/${p.organiserId}`} className="font-medium underline-offset-4 hover:underline">{p.organiserName}</Link></Td>
              <Td>{p.eventName ? <>{p.eventName} <code className="text-xs text-muted">{p.eventCode}</code></> : "—"}</Td><Td><code className="text-xs">{p.bankReference ?? "—"}</code></Td><Td className="text-sm">{t(`m.${p.method}`)}</Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><Badge s={p.status} />{p.voidReason && <span className="block text-xs text-muted">{p.voidReason}</span>}</Td>
              <Td className="text-end"><div className="flex justify-end gap-1">
                <a href={`/api/accounting/organiser-payments/${p.id}/receipt`} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm hover:bg-surface-2" title={tf("receipt")}><FileDown className="size-3.5" aria-hidden />{tf("receipt")}</a>
                <Button size="sm" variant="ghost" onClick={() => setView(p.id)} aria-label={tf("view")}><Eye className="size-3.5" aria-hidden /></Button>
                {can("accounting.manage") && p.status !== "VOIDED" && <>
                {p.status === "PENDING" && <Button size="sm" onClick={() => markPaid(p)}><CheckCircle2 className="size-3.5" aria-hidden />{t("markPaid")}</Button>}
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label={tf("editItem")}><Pencil className="size-3.5" aria-hidden /></Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) { setReason(""); setVoiding(p); } }} aria-label={tf("deleteItem")}><Trash2 className="size-3.5" aria-hidden /></Button></>}</div></Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {open && <PaymentDialog open={open} onClose={() => setOpen(false)} onSaved={() => void reload()} mode={mode} />}
      {agent && <PaymentAgentDialog open={agent} onClose={() => setAgent(false)} onSaved={() => void reload()} />}
      {view && <PaymentViewDialog id={view} onClose={() => setView(null)} />}
      {editing && <PaymentEditDialog p={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      <ConfirmDialog open={!!voiding} onClose={() => setVoiding(null)} title={tf("payDelete.title")} description={tf("payDelete.desc")} confirmLabel={tf("deleteItem")}
        onConfirm={async () => { try { await api(`/api/accounting/organiser-payments/${voiding!.id}/void`, { json: { reason } }); toast("ok", t("voided")); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("voidReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}
