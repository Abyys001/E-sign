"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Link2, Undo2, Unlink } from "lucide-react";
import { useMe } from "@/components/app/me";
import { InvoicesCard, PaymentInfo, RefundDialog, type Charge } from "@/components/accounting/payments";
import { Badge, CopyText, DL, Money, Reason, useMoney } from "@/components/accounting/kit";
import { MatchDialog } from "@/components/accounting/match";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Textarea } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { bpsToPercent } from "@/lib/money";

type Line = { id: number; accountCode: string; accountName: string; debit: number; credit: number; memo: string | null };
type Entry = { id: string; seq: number; entryType: string; entryDate: string; status: string; description: string; reason: string | null; lines: Line[] };
type Detail = {
  transaction: { id: string; balanceTransactionId: string; type: string; kind: string; reportingCategory: string | null; sourceId: string | null; amount: number; fee: number; net: number; currency: string; exchangeRate: string | null; description: string | null; stripeStatus: string | null; stripeCreatedAt: string; availableOn: string | null; chargeId: string | null; payoutId: string | null; eventCode: string | null; eventId: string | null; matchStatus: string; matchReason: string | null; matchMethod: string | null; reconciliationStatus: string; reconciliationNote: string | null; commissionAmount: number | null; organiserAmount: number | null; ticketQuantity: number | null; livemode: boolean; feeDetails: Array<{ amount: number; currency: string; type: string; description: string | null }> };
  charge: { chargeId: string; paymentIntentId: string | null; status: string; customerName: string | null; customerEmail: string | null; description: string | null; metadata: Record<string, string>; amount: number; amountRefunded: number; currency: string } | null;
  event: { id: string; name: string; code: string } | null; organiser: { id: string; name: string } | null;
  agreement: { version: number; percentBps: number; percentBasis: string; fixedPerTicket: number; stripeFeesBorneBy: string } | null;
  related: Array<{ id: string; balanceTransactionId: string; kind: string; amount: number; fee: number; net: number; currency: string; stripeCreatedAt: string; reconciliationStatus: string }>;
  sale: { gross: number; refunded: number; disputed: number; fee: number; net: number; commission: number; organiser: number } | null;
  refunds: Array<{ id: string; refundId: string; amount: number; currency: string; status: string | null; reason: string | null; failureReason: string | null; note: string | null; keepBookingFee: boolean; stripeCreatedAt: string }>;
  disputes: Array<{ id: string; disputeId: string; amount: number; currency: string; reason: string | null; status: string; stripeCreatedAt: string }>;
  entries: Entry[]; history: Array<{ id: string; action: string; reason: string | null; userName: string | null; createdAt: string; fromStatus: string | null; toStatus: string | null }>;
};

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <TxDetail id={id} />; }

function TxDetail({ id }: { id: string }) {
  const t = useTranslations("accounting.detail");
  const tk = useTranslations("accounting.kind");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const fm = useMoney();
  const { data, loading, error, reload } = useApi<Detail>(`/api/accounting/transactions/${id}`);
  const [match, setMatch] = useState(false);
  const [refund, setRefund] = useState(false);
  const [unmatch, setUnmatch] = useState(false);
  const [reason, setReason] = useState("");
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-64" /></div>;
  if (error || !data) return <EmptyState title={t("notFound")} description={error?.message} />;
  const x = data.transaction, c = x.currency;
  const s = data.sale;
  const canMatch = can("accounting.manage") && ["SALE", "REFUND", "DISPUTE", "DISPUTE_REVERSAL", "OTHER"].includes(x.kind);
  return (
    <div className="space-y-6">
      <PageHeader title={<span className="flex items-center gap-3">{t("title")} <Badge s={x.reconciliationStatus} /></span>} description={x.description ?? undefined}
        actions={<><LinkButton href="/accounting/transactions"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t("back")}</LinkButton>
          {canMatch && x.matchStatus === "MATCHED" && x.kind !== "OTHER" && <Button onClick={() => setUnmatch(true)}><Unlink className="size-4" aria-hidden />{t("unmatch")}</Button>}
          {can("accounting.manage") && x.kind === "SALE" && data.charge && data.charge.status === "succeeded" && !(data.charge as unknown as Charge).disputed && data.charge.amountRefunded < data.charge.amount && <Button variant="danger" onClick={() => setRefund(true)}><Undo2 className="size-4" aria-hidden />{t("refund")}</Button>}
          {canMatch && <Button variant="primary" onClick={() => setMatch(true)}><Link2 className="size-4" aria-hidden />{x.kind === "OTHER" ? t("classify") : x.matchStatus === "MATCHED" ? t("reassign") : t("match")}</Button>}</>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardHeader title={t("stripe")} /><div className="p-5"><DL items={[
          [t("id"), <CopyText key="i" text={x.balanceTransactionId} />], [t("date"), fmtDate(x.stripeCreatedAt, locale)], [t("type"), `${tk(x.kind)} (${x.type}${x.reportingCategory ? ` / ${x.reportingCategory}` : ""})`],
          [t("stripeStatus"), x.stripeStatus], [t("available"), x.availableOn ? fmtDate(x.availableOn, locale, { dateStyle: "medium" }) : null], [t("source"), x.sourceId ? <CopyText key="s" text={x.sourceId} /> : null],
          [t("customer"), data.charge ? [data.charge.customerName, data.charge.customerEmail].filter(Boolean).join(" · ") || null : null], [t("description"), x.description ?? data.charge?.description ?? null],
          [t("paymentIntent"), data.charge?.paymentIntentId ?? null], [t("payout"), x.payoutId], [t("exchangeRate"), x.exchangeRate], [t("mode"), x.livemode ? "LIVE" : "TEST"],
        ]} /></div></Card>
        <Card><CardHeader title={t("allocation")} /><div className="p-5"><DL items={[
          [t("event"), data.event ? <Link key="e" href={`/accounting/events/${data.event.id}`} className="underline underline-offset-4">{data.event.name}</Link> : <span key="e" className="text-muted">{t("none")}</span>],
          [t("eventCode"), x.eventCode ? <code key="c">{x.eventCode}</code> : null], [t("organiser"), data.organiser ? <Link key="o" href={`/accounting/organisers/${data.organiser.id}`} className="underline underline-offset-4">{data.organiser.name}</Link> : null],
          [t("method"), x.matchMethod], [t("reasonLabel"), x.matchReason ? <Reason key="r" r={x.matchReason} /> : null], [t("note"), x.reconciliationNote],
          [t("agreement"), data.agreement ? `v${data.agreement.version}: ${bpsToPercent(data.agreement.percentBps)} % ${data.agreement.percentBasis === "NET" ? t("ofNet") : data.agreement.percentBasis === "ADDED" ? t("onTop") : t("ofGross")}${data.agreement.fixedPerTicket ? ` + ${fm(data.agreement.fixedPerTicket, c)} ${t("perTicket")}` : ""} · ${t("feesBy")} ${data.agreement.stripeFeesBorneBy.toLowerCase()}` : null],
          [t("tickets"), x.ticketQuantity],
        ]} /></div></Card>
      </div>
      <PaymentInfo charge={data.charge as unknown as Charge | null} refunds={data.refunds} disputes={data.disputes} btId={x.id} onChanged={() => void reload()} />
      {x.chargeId && ["SALE", "REFUND", "DISPUTE"].includes(x.kind) && <InvoicesCard saleBtId={x.id} related={data.related.length ? data.related : [x]} charge={data.charge as unknown as Charge | null} />}
      <Card><CardHeader title={t("amounts")} description={s ? t("amountsSale") : undefined} />
        <div className="grid gap-px overflow-hidden rounded-b-card bg-line sm:grid-cols-3 lg:grid-cols-7">
          {(s ? [[t("gross"), s.gross], [t("refund"), -s.refunded], [t("chargeback"), -s.disputed], [t("fee"), -s.fee], [t("net"), s.net], [t("commission"), s.commission], [t("organiserPayable"), s.organiser]]
            : [[t("amount"), x.amount], [t("fee"), -x.fee], [t("net"), x.net]]).map(([k, v]) => (
            <div key={k as string} className="bg-surface p-4"><p className="text-xs text-muted">{k}</p><p className="mt-1 text-lg font-semibold"><Money v={v as number} c={c} /></p></div>))}
        </div>
        {x.feeDetails.length > 0 && <p className="px-5 py-3 text-xs text-muted">{t("feeDetails")}: {x.feeDetails.map((f) => `${f.description ?? f.type} ${fm(f.amount, f.currency)}`).join(" · ")}</p>}
      </Card>
      {data.related.length > 1 && <Card><CardHeader title={t("related")} /><TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("type")}</Th><Th>{t("id")}</Th><Th className="text-end">{t("amount")}</Th><Th className="text-end">{t("fee")}</Th><Th className="text-end">{t("net")}</Th><Th>{t("status")}</Th></tr></thead>
        <tbody>{data.related.map((r) => <Tr key={r.id}><Td className="text-muted">{fmtDate(r.stripeCreatedAt, locale)}</Td><Td>{tk(r.kind)}</Td><Td><Link href={`/accounting/transactions/${r.id}`} className="underline-offset-4 hover:underline"><code className="text-xs">{r.balanceTransactionId}</code></Link></Td><Td className="text-end"><Money v={r.amount} c={r.currency} /></Td><Td className="text-end"><Money v={r.fee} c={r.currency} /></Td><Td className="text-end"><Money v={r.net} c={r.currency} /></Td><Td><Badge s={r.reconciliationStatus} /></Td></Tr>)}</tbody></Table></TableWrap></Card>}
      <Card><CardHeader title={t("ledger")} description={t("ledgerDesc")} />
        {data.entries.map((e) => <div key={e.id} className="border-b border-line last:border-0">
          <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"><span className="num text-muted">#{e.seq}</span><span>{e.entryDate}</span><span className="font-medium">{e.entryType}</span><Badge s={e.status} /><span className="min-w-0 flex-1 truncate text-muted">{e.reason}</span></div>
          <TableWrap><Table><thead><tr><Th>{t("account")}</Th><Th>{t("memo")}</Th><Th className="text-end">{t("debit")}</Th><Th className="text-end">{t("credit")}</Th></tr></thead>
            <tbody>{e.lines.map((l) => <Tr key={l.id}><Td><code className="text-xs">{l.accountCode}</code> {l.accountName}</Td><Td className="text-muted">{l.memo}</Td><Td className="text-end">{l.debit ? <Money v={l.debit} c={c} /> : ""}</Td><Td className="text-end">{l.credit ? <Money v={l.credit} c={c} /> : ""}</Td></Tr>)}</tbody></Table></TableWrap>
        </div>)}
      </Card>
      {data.history.length > 0 && <Card><CardHeader title={t("history")} /><ul className="divide-y divide-line">{data.history.map((h) => <li key={h.id} className="px-5 py-3 text-sm"><span className="font-medium">{h.action}</span> · {h.userName ?? t("system")} · <span className="text-muted">{fmtDate(h.createdAt, locale)}</span>{h.fromStatus && <> · <Badge s={h.fromStatus} /> → <Badge s={h.toStatus} /></>}{h.reason && <p className="mt-1 text-muted">{h.reason}</p>}</li>)}</ul></Card>}
      {refund && data.charge && <RefundDialog btId={x.id} charge={data.charge as unknown as Charge} bookingFee={x.commissionAmount ?? 0} onClose={() => setRefund(false)} onDone={() => void reload()} />}
      <MatchDialog tx={x} open={match} onClose={() => setMatch(false)} onDone={reload} />
      <ConfirmDialog open={unmatch} onClose={() => setUnmatch(false)} title={t("unmatchTitle")} description={t("unmatchDesc")} confirmLabel={t("unmatch")}
        onConfirm={async () => { try { await api(`/api/accounting/reconciliation/${x.id}/unmatch`, { json: { reason } }); toast("ok", t("unmatched")); setReason(""); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("reasonLabel")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}
