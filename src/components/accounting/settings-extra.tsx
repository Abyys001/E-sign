"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";
import { bpsToPercent, percentToBps } from "@/lib/money";

type InvS = { legalName: string | null; address: string | null; companyNumber: string | null; vatNumber: string | null; email: string | null; website: string | null; footer: string | null; bookingFeeVatBps: number; ticketVatMode: "AGENT" | "INCLUDED"; ticketVatBps: number; invoicePrefix: string; creditNotePrefix: string };

/** Seller details and VAT treatment printed on customer invoices, credit notes and VAT invoices. */
export function InvoiceSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.pay.invSettings");
  const toast = useToast();
  const { data } = useApi<InvS>("/api/accounting/settings/invoices");
  const [v, setV] = useState<(Omit<InvS, "bookingFeeVatBps" | "ticketVatBps"> & { feeVat: string; ticketVat: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !v) setV({ ...data, feeVat: bpsToPercent(data.bookingFeeVatBps), ticketVat: bpsToPercent(data.ticketVatBps) }); }, [data, v]);
  if (!v) return <Skeleton className="h-40" />;
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV({ ...v, [k]: x });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const { feeVat, ticketVat, ...rest } = v;
      await api("/api/accounting/settings/invoices", { method: "PATCH", json: { ...rest, bookingFeeVatBps: percentToBps(feeVat || "0"), ticketVatBps: percentToBps(ticketVat || "0") } });
      toast("ok", t("saved"));
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const I = (k: "legalName" | "companyNumber" | "vatNumber" | "email" | "website" | "invoicePrefix" | "creditNotePrefix", label: string, hint?: string) => <Field label={label} hint={hint}>{(p) => <Input {...p} disabled={!admin} value={v[k] ?? ""} onChange={(e) => set(k, e.target.value)} />}</Field>;
  return (
    <Card><CardHeader title={t("title")} description={t("desc")} />
      <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {I("legalName", t("legalName"))}{I("companyNumber", t("companyNumber"))}{I("vatNumber", t("vatNumber"), t("vatNumberHint"))}
        <div className="sm:col-span-2 lg:col-span-3"><Field label={t("address")}>{(p) => <Textarea {...p} disabled={!admin} value={v.address ?? ""} onChange={(e) => set("address", e.target.value)} className="min-h-20" />}</Field></div>
        {I("email", t("email"))}{I("website", t("website"))}
        <Field label={t("feeVat")} hint={t("feeVatHint")}>{(p) => <Input {...p} disabled={!admin} inputMode="decimal" value={v.feeVat} onChange={(e) => set("feeVat", e.target.value)} />}</Field>
        <Field label={t("ticketMode")} hint={t(`ticketModeHint.${v.ticketVatMode}`)}>{(p) => <Select {...p} disabled={!admin} value={v.ticketVatMode} onChange={(e) => set("ticketVatMode", e.target.value as "AGENT")}><option value="AGENT">{t("modes.AGENT")}</option><option value="INCLUDED">{t("modes.INCLUDED")}</option></Select>}</Field>
        {v.ticketVatMode === "INCLUDED" && <Field label={t("ticketVat")}>{(p) => <Input {...p} disabled={!admin} inputMode="decimal" value={v.ticketVat} onChange={(e) => set("ticketVat", e.target.value)} />}</Field>}
        {I("invoicePrefix", t("invoicePrefix"))}{I("creditNotePrefix", t("creditNotePrefix"))}
        <div className="sm:col-span-2 lg:col-span-3"><Field label={t("footer")}>{(p) => <Textarea {...p} disabled={!admin} value={v.footer ?? ""} onChange={(e) => set("footer", e.target.value)} className="min-h-16" />}</Field></div>
        <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t("accountantNote")}</p>
        {err && <div className="sm:col-span-2 lg:col-span-3"><Callout tone="warn">{err}</Callout></div>}
        {admin && <div className="flex justify-end sm:col-span-2 lg:col-span-3"><Button variant="primary" loading={busy} onClick={save}>{t("save")}</Button></div>}
      </div>
    </Card>
  );
}
