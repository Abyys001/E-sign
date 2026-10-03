"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banknote, CheckCircle2, Undo2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, Money, useMode } from "@/components/accounting/kit";
import { PaymentDialog } from "@/components/accounting/forms";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Select, Textarea } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type P = { id: string; organiserId: string; organiserName: string; eventName: string | null; eventCode: string | null; amount: number; currency: string; paymentDate: string; bankReference: string | null; method: string; status: string; notes: string | null; voidReason: string | null; createdByName: string | null; createdAt: string };

export default function PaymentsPage() {
  const t = useTranslations("accounting.payments");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { mode, q } = useMode();
  const [status, setStatus] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false);
  const [voiding, setVoiding] = useState<P | null>(null); const [reason, setReason] = useState("");
  const { data, loading, reload } = useApi<{ items: P[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/organiser-payments?page=${page}&pageSize=50${status ? `&status=${status}` : ""}`));
  const markPaid = async (p: P) => { try { await api(`/api/accounting/organiser-payments/${p.id}`, { method: "PATCH", json: { status: "PAID" } }); toast("ok", t("markedPaid")); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        <Select aria-label={t("status")} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto"><option value="">{t("all")}</option>{["PAID", "PENDING", "VOIDED"].map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>
        {can("accounting.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Banknote className="size-4" aria-hidden />{t("record")}</Button>}</>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("organiser")}</Th><Th>{t("event")}</Th><Th>{t("reference")}</Th><Th>{t("method")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((p) => <Tr key={p.id}>
              <Td className="whitespace-nowrap">{p.paymentDate}<span className="block text-xs text-muted">{p.createdByName} · {fmtDate(p.createdAt, locale, { dateStyle: "short" })}</span></Td>
              <Td><Link href={`/accounting/organisers/${p.organiserId}`} className="font-medium underline-offset-4 hover:underline">{p.organiserName}</Link></Td>
              <Td>{p.eventName ? <>{p.eventName} <code className="text-xs text-muted">{p.eventCode}</code></> : "—"}</Td><Td><code className="text-xs">{p.bankReference ?? "—"}</code></Td><Td className="text-sm">{t(`m.${p.method}`)}</Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><Badge s={p.status} />{p.voidReason && <span className="block text-xs text-muted">{p.voidReason}</span>}</Td>
              <Td className="text-end">{can("accounting.manage") && p.status !== "VOIDED" && <div className="flex justify-end gap-1">
                {p.status === "PENDING" && <Button size="sm" onClick={() => markPaid(p)}><CheckCircle2 className="size-3.5" aria-hidden />{t("markPaid")}</Button>}
                <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) { setReason(""); setVoiding(p); } }}><Undo2 className="size-3.5" aria-hidden />{t("void")}</Button></div>}</Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {open && <PaymentDialog open={open} onClose={() => setOpen(false)} onSaved={() => void reload()} mode={mode} />}
      <ConfirmDialog open={!!voiding} onClose={() => setVoiding(null)} title={t("voidTitle")} description={t("voidDesc")} confirmLabel={t("void")}
        onConfirm={async () => { try { await api(`/api/accounting/organiser-payments/${voiding!.id}/void`, { json: { reason } }); toast("ok", t("voided")); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("voidReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}
