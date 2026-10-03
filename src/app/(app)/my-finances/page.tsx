"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { HandCoins, Percent, Receipt, Scale, Wallet } from "lucide-react";
import { AmountCard, Money } from "@/components/accounting/kit";
import { pct, SettlementBadge, type Settlement } from "@/components/accounting/finance";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useApi } from "@/lib/api";

type F = { currency: string; tickets: number; grossSales: number; refunds: number; chargebacks: number; netSales: number; bookingFees: number; eventFees: number; feesRecharged: number; deductions: number; organiserDue: number; organiserPaid: number; remaining: number; pendingPayments: number; settlement: Settlement };
type Data = {
  organisers: Array<{ id: string; name: string; eventCount: number; totals: F[]; events: Array<F & { eventId: string; eventName: string; eventCode: string; startsOn: string | null; bookingFeeBps: number | null }> }>;
  payments: Array<{ id: string; organiserId: string; eventName: string | null; amount: number; currency: string; paymentDate: string; method: string; reference: string | null; status: string }>;
};

/** Organiser portal: an organiser's own sales, booking fees, settlement and payments. Never shows Bilit's margin or costs. */
export default function MyFinances() {
  const t = useTranslations("accounting.fin.portal");
  const tf = useTranslations("accounting.fin");
  const tp = useTranslations("accounting.payments");
  const locale = useLocale();
  const { data, loading, error } = useApi<Data>("/api/my-finances");
  const [orgId, setOrgId] = useState<string | null>(null); const [cur, setCur] = useState<string | null>(null);
  if (loading && !data) return <Skeleton className="h-64" />;
  if (error || !data) return <EmptyState title={t("title")} description={error?.message} />;
  const o = data.organisers.find((x) => x.id === orgId) ?? data.organisers[0]!;
  const f = o.totals.find((x) => x.currency === cur) ?? o.totals[0];
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub", { name: o.name })} actions={<>
        {data.organisers.length > 1 && <Select aria-label={tf("organiser")} value={o.id} onChange={(e) => setOrgId(e.target.value)} className="w-auto">{data.organisers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        {o.totals.length > 1 && f && <Select aria-label={tf("currency")} value={f.currency} onChange={(e) => setCur(e.target.value)} className="w-auto uppercase">{o.totals.map((x) => <option key={x.currency} value={x.currency}>{x.currency.toUpperCase()}</option>)}</Select>}</>} />
      {!f ? <Card><EmptyState title={t("empty")} /></Card> : <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <AmountCard label={tf("k.grossSales")} v={f.grossSales} c={f.currency} tone="pos" icon={Receipt} hint={<>{tf("k.tickets")}: {f.tickets.toLocaleString(locale)}</>} />
          <AmountCard label={tf("k.bookingFees")} v={f.bookingFees} c={f.currency} tone="warn" icon={Percent} />
          <AmountCard label={tf("k.organiserDue")} v={f.organiserDue} c={f.currency} tone="info" icon={Scale} />
          <AmountCard label={tf("k.organiserPaid")} v={f.organiserPaid} c={f.currency} tone="bal" icon={Wallet} />
          <AmountCard label={tf("k.remaining")} v={f.remaining} c={f.currency} tone={f.remaining === 0 ? "pos" : "warn"} icon={HandCoins} hint={<SettlementBadge s={f.settlement} />} />
        </div>
        <Card><CardHeader title={t("events")} />
          <TableWrap><Table><thead><tr><Th>{tf("events.event")}</Th><Th className="text-end">{tf("events.tickets")}</Th><Th className="text-end">{tf("events.gross")}</Th><Th className="text-end">{tf("k.refunds")}</Th><Th className="text-end">{tf("events.fee")}</Th><Th className="text-end">{tf("events.due")}</Th><Th className="text-end">{tf("events.paid")}</Th><Th className="text-end">{tf("events.remaining")}</Th><Th>{tf("settlement.label")}</Th></tr></thead>
            <tbody>{o.events.filter((e) => e.currency === f.currency).map((e) => <Tr key={e.eventId}>
              <Td><span className="font-medium">{e.eventName}</span><span className="block text-xs text-muted">{e.eventCode}{e.startsOn ? ` · ${e.startsOn}` : ""}</span></Td>
              <Td className="text-end tabular-nums">{e.tickets.toLocaleString(locale)}</Td><Td className="text-end"><Money v={e.grossSales} c={e.currency} /></Td><Td className="text-end"><Money v={e.refunds + e.chargebacks} c={e.currency} /></Td>
              <Td className="text-end"><Money v={e.bookingFees} c={e.currency} /><span className="block text-xs text-muted">{pct(e.bookingFeeBps)}</span></Td>
              <Td className="text-end"><Money v={e.organiserDue} c={e.currency} /></Td><Td className="text-end"><Money v={e.organiserPaid} c={e.currency} /></Td><Td className="text-end"><Money v={e.remaining} c={e.currency} strong /></Td><Td><SettlementBadge s={e.settlement} /></Td></Tr>)}</tbody></Table></TableWrap>
        </Card>
      </>}
      <Card><CardHeader title={t("payments")} />
        {(() => { const ps = data.payments.filter((p) => p.organiserId === o.id); return !ps.length ? <EmptyState title={tp("empty")} /> : (
          <TableWrap><Table><thead><tr><Th>{tp("date")}</Th><Th>{tp("event")}</Th><Th className="text-end">{tp("amount")}</Th><Th>{tp("method")}</Th><Th>{tp("reference")}</Th><Th>{tp("status")}</Th></tr></thead>
            <tbody>{ps.map((p) => <Tr key={p.id}><Td>{p.paymentDate}</Td><Td>{p.eventName ?? tp("noEvent")}</Td><Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td>{tp(`m.${p.method}`)}</Td><Td><code className="text-xs">{p.reference ?? "—"}</code></Td><Td>{tp(`st.${p.status}`)}</Td></Tr>)}</tbody></Table></TableWrap>); })()}
      </Card>
    </div>
  );
}
