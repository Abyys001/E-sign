"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, FilePlus2, Pencil, Receipt } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge, DL, Money, useMode } from "@/components/accounting/kit";
import { AgreementFields, agreementFrom, agreementPayload, emptyAgreement, EventDialog, type AgreementValue } from "@/components/accounting/forms";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { bpsToPercent, formatMoney } from "@/lib/money";

type Ag = { id: string; version: number; percentBps: number; percentBasis: string; fixedPerTicket: number; fixedEventFee: number; stripeFeesBorneBy: string; chargebacksBorneBy: string; refundsReverseCommission: boolean; notes: string | null; createdAt: string };
type Sum = { currency: string; grossSales: number; refunds: number; chargebacks: number; netSales: number; stripeFees: number; stripeFeesRecharged: number; commission: number; eventFees: number; otherRevenue: number; otherCosts: number; bilitRevenue: number; organiserPayable: number; organiserPayments: number; organiserOutstanding: number; bilitProfit: number };
type D = { event: { id: string; name: string; code: string; currency: string; status: string; startsOn: string | null; organiserId: string | null; organiserName: string | null; notes: string | null; currentAgreementId: string | null }; agreements: Ag[]; summary: Sum[] };

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <EventDetail id={id} />; }

function EventDetail({ id }: { id: string }) {
  const t = useTranslations("accounting.events");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const { mode, q } = useMode();
  const { data, loading, error, reload } = useApi<D>(q(`/api/accounting/events/${id}`));
  const [edit, setEdit] = useState(false); const [agOpen, setAgOpen] = useState(false);
  const [ag, setAg] = useState<AgreementValue>(emptyAgreement()); const [reason, setReason] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (loading && !data) return <Skeleton className="h-64" />;
  if (error || !data) return <EmptyState title={t("notFound")} description={error?.message} />;
  const e = data.event, cur = data.agreements.find((a) => a.id === e.currentAgreementId);
  const saveAg = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/accounting/events/${id}/agreement`, { json: { ...agreementPayload(ag, e.currency), reason } }); toast("ok", t("agreementSaved")); setAgOpen(false); setReason(""); await reload(); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const fee = async () => { try { await api(`/api/accounting/events/${id}/event-fee`, { json: { mode, date: new Date().toISOString().slice(0, 10) } }); toast("ok", t("feePosted")); await reload(); } catch (x) { toast("error", errMsg(x)); } };
  const rows: Array<[string, keyof Sum, boolean?]> = [["grossSales", "grossSales"], ["refunds", "refunds", true], ["chargebacks", "chargebacks", true], ["stripeFees", "stripeFees", true], ["feesRecharged", "stripeFeesRecharged"], ["commission", "commission"], ["eventFees", "eventFees"], ["otherRevenue", "otherRevenue"], ["otherCosts", "otherCosts", true], ["organiserPayable", "organiserPayable"], ["organiserPaid", "organiserPayments"], ["outstanding", "organiserOutstanding"], ["bilitProfit", "bilitProfit"]];
  return (
    <div className="space-y-6">
      <PageHeader title={<span className="flex items-center gap-3">{e.name} <Badge s={e.status} /></span>} description={<code>{e.code}</code>}
        actions={<><LinkButton href="/accounting/events"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t("back")}</LinkButton>
          <LinkButton href={`/accounting/transactions?eventId=${id}`}><Receipt className="size-4" aria-hidden />{t("transactions")}</LinkButton>
          {can("accounting.manage") && <Button onClick={() => setEdit(true)}><Pencil className="size-4" aria-hidden />{t("edit")}</Button>}</>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card><CardHeader title={t("details")} /><div className="p-5"><DL items={[
          [t("code"), <code key="c">{e.code}</code>], [t("organiser"), e.organiserId ? <Link key="o" href={`/accounting/organisers/${e.organiserId}`} className="underline underline-offset-4">{e.organiserName}</Link> : <span key="o" className="font-medium">{t("noOrganiserWarn")}</span>],
          [t("currency"), e.currency.toUpperCase()], [t("startsOn"), e.startsOn], [t("notes"), e.notes],
        ]} /></div></Card>
        <Card><CardHeader title={t("profit")} description={t("profitDesc")} />
          {data.summary.length === 0 ? <EmptyState title={t("noMoney")} /> : <TableWrap><Table><thead><tr><Th>{t("line")}</Th>{data.summary.map((s) => <Th key={s.currency} className="text-end uppercase">{s.currency}</Th>)}</tr></thead>
            <tbody>{rows.map(([k, f, neg]) => <Tr key={k}><Td className={k === "bilitProfit" || k === "outstanding" ? "font-semibold" : ""}>{t(`p.${k}`)}</Td>{data.summary.map((s) => <Td key={s.currency} className="text-end"><Money v={neg ? -(s[f] as number) : (s[f] as number)} c={s.currency} strong={k === "bilitProfit" || k === "outstanding"} /></Td>)}</Tr>)}</tbody></Table></TableWrap>}
        </Card>
      </div>
      <Card><CardHeader title={t("agreements")} description={t("agreementsDesc")} action={can("accounting.manage") && <div className="flex gap-2">
          {cur && cur.fixedEventFee > 0 && <Button size="sm" onClick={fee}>{t("postFee", { amount: formatMoney(cur.fixedEventFee, e.currency, locale) })}</Button>}
          <Button size="sm" variant="primary" onClick={() => { setAg(cur ? agreementFrom(cur, e.currency) : emptyAgreement()); setAgOpen(true); }}><FilePlus2 className="size-4" aria-hidden />{t("newAgreement")}</Button></div>} />
        <TableWrap><Table><thead><tr><Th>{t("version")}</Th><Th>{t("percent")}</Th><Th>{t("perTicket")}</Th><Th>{t("eventFee")}</Th><Th>{t("feesBy")}</Th><Th>{t("chargebacksBy")}</Th><Th>{t("created")}</Th></tr></thead>
          <tbody>{data.agreements.map((a) => <Tr key={a.id} className={a.id === e.currentAgreementId ? "font-medium" : "text-muted"}><Td>v{a.version}{a.id === e.currentAgreementId && <span className="ms-2"><Badge s="ACTIVE" /></span>}</Td><Td>{bpsToPercent(a.percentBps)} % {a.percentBasis === "NET" ? t("ofNet") : t("ofGross")}</Td><Td><Money v={a.fixedPerTicket} c={e.currency} /></Td><Td><Money v={a.fixedEventFee} c={e.currency} /></Td><Td>{t(`by.${a.stripeFeesBorneBy}`)}</Td><Td>{t(`by.${a.chargebacksBorneBy}`)}</Td><Td>{fmtDate(a.createdAt, locale)}</Td></Tr>)}</tbody></Table></TableWrap>
      </Card>
      {edit && <EventDialog open={edit} onClose={() => setEdit(false)} onSaved={() => void reload()} eventId={id} initial={{ name: e.name, code: e.code, currency: e.currency, organiserId: e.organiserId ?? "", startsOn: e.startsOn ?? "", status: e.status, notes: e.notes ?? "" }} />}
      <Modal open={agOpen} onClose={() => setAgOpen(false)} size="lg" title={t("newAgreement")} description={t("newAgreementDesc")}
        footer={<><Button onClick={() => setAgOpen(false)}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 3} onClick={saveAg}>{t("saveAgreement")}</Button></>}>
        <div className="space-y-4"><AgreementFields v={ag} onChange={setAg} currency={e.currency} /><Field label={t("changeReason")} required>{(p) => <Input {...p} value={reason} onChange={(x) => setReason(x.target.value)} />}</Field>{err && <Callout tone="warn">{err}</Callout>}</div>
      </Modal>
    </div>
  );
}
