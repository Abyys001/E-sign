"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarPlus, Download, Import, Search } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, useOptions, type RangeKey } from "@/components/accounting/kit";
import { EventDialog, ImportEventsDialog } from "@/components/accounting/forms";
import { pct, SettlementBadge, SETTLEMENTS, type Fig } from "@/components/accounting/finance";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { useApi } from "@/lib/api";

type Row = Fig & { eventId: string; eventName: string; eventCode: string; eventStatus: string; startsOn: string | null; organiserId: string | null; organiserName: string | null; bookingFeeBps: number | null };
type Resp = { items: Row[]; total: number; totals: Fig[]; page: number; pageSize: number };

export default function EventsPage() {
  const t = useTranslations("accounting.events");
  const tf = useTranslations("accounting.fin");
  const locale = useLocale();
  const router = useRouter();
  const ensure = useElevation();
  const doExport = useExport();
  const { can } = useMe();
  const { q: withMode } = useMode();
  const organisers = useOptions<{ id: string; name: string }>("/api/accounting/organisers?pageSize=200");
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const [f, setF] = useState({ q: "", organiserId: "", currency: "", status: "", settlement: "", payments: "" });
  const [page, setPage] = useState(1); const [open, setOpen] = useState(false); const [imp, setImp] = useState(false);
  const dq = useDebounced(f.q, 300);
  const r = rangeFor(range.key, range);
  const qs = `${rangeQuery(r)}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${(["organiserId", "currency", "status", "settlement", "payments"] as const).map((k) => (f[k] ? `&${k}=${f[k]}` : "")).join("")}`;
  const { data, loading, reload } = useApi<Resp>(withMode(`/api/accounting/finance/events?page=${page}&pageSize=50${qs}`));
  const set = (k: keyof typeof f, v: string) => { setF((o) => ({ ...o, [k]: v })); setPage(1); };
  const currencies = [...new Set((data?.totals ?? []).map((x) => x.currency).concat(f.currency ? [f.currency] : []))].sort();
  return (
    <div>
      <PageHeader title={tf("events.title")} description={tf("events.sub")} actions={<>
        <Button onClick={() => doExport(ensure, withMode(`/api/accounting/finance/events?x=1${qs}`))}><Download className="size-4" aria-hidden />{tf("export")}</Button>
        {can("accounting.manage") && <><Button onClick={() => setImp(true)}><Import className="size-4" aria-hidden />{t("importTx")}</Button><Button variant="primary" onClick={() => setOpen(true)}><CalendarPlus className="size-4" aria-hidden />{t("create")}</Button></>}</>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
        <Select aria-label={tf("organiser")} value={f.organiserId} onChange={(e) => set("organiserId", e.target.value)} className="w-auto"><option value="">{tf("filters.allOrganisers")}</option>{organisers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
        <Select aria-label={tf("currency")} value={f.currency} onChange={(e) => set("currency", e.target.value)} className="w-auto uppercase"><option value="">{tf("filters.allCurrencies")}</option>{currencies.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</Select>
        <Select aria-label={t("status")} value={f.status} onChange={(e) => set("status", e.target.value)} className="w-auto"><option value="">{tf("filters.allStatuses")}</option>{["ACTIVE", "INACTIVE", "ARCHIVED"].map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>
        <Select aria-label={tf("settlement.label")} value={f.settlement} onChange={(e) => set("settlement", e.target.value)} className="w-auto"><option value="">{tf("filters.allSettlement")}</option>{SETTLEMENTS.map((s) => <option key={s} value={s}>{tf(`settlement.${s}`)}</option>)}</Select>
        <Select aria-label={tf("filters.payments")} value={f.payments} onChange={(e) => set("payments", e.target.value)} className="w-auto"><option value="">{tf("filters.anyPayments")}</option><option value="PENDING">{tf("filters.pendingPayments")}</option><option value="NONE">{tf("filters.noPending")}</option></Select>
      </div>

      {data && data.totals.length > 0 && <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">{data.totals.map((x) => (
        <Card key={x.currency} className="p-4 text-sm">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{tf("events.totals", { c: x.currency.toUpperCase() })}</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-muted">{tf("k.grossSales")}</dt><dd className="text-end"><Money v={x.grossSales} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.bookingFees")}</dt><dd className="text-end text-fin-pos"><Money v={x.bookingFees} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.refunds")}</dt><dd className="text-end text-fin-neg"><Money v={x.refunds + x.chargebacks} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.processingFees")}</dt><dd className="text-end"><Money v={x.processingFees} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.organiserDue")}</dt><dd className="text-end"><Money v={x.organiserDue} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.organiserPaid")}</dt><dd className="text-end"><Money v={x.organiserPaid} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.remaining")}</dt><dd className="text-end text-fin-warn"><Money v={x.remaining} c={x.currency} /></dd>
            <dt className="text-muted">{tf("k.bilitProfit")}</dt><dd className="text-end font-semibold"><Money v={x.bilitProfit} c={x.currency} /></dd>
          </dl>
        </Card>))}</div>}

      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} action={can("accounting.manage") && <Button variant="primary" onClick={() => setImp(true)}><Import className="size-4" aria-hidden />{t("importTx")}</Button>} /> : <>
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr>
            <Th className="sticky start-0 z-10">{tf("events.event")}</Th><Th>{tf("organiser")}</Th><Th className="text-end">{tf("events.tickets")}</Th><Th className="text-end">{tf("events.gross")}</Th>
            <Th className="text-end">{tf("k.refunds")}</Th><Th className="text-end">{tf("k.netSales")}</Th><Th className="text-end">{tf("events.fee")}</Th><Th className="text-end">{tf("events.processing")}</Th>
            <Th className="text-end">{tf("events.expenses")}</Th><Th className="text-end">{tf("events.due")}</Th><Th className="text-end">{tf("events.paid")}</Th><Th className="text-end">{tf("events.remaining")}</Th>
            <Th className="text-end">{tf("events.profit")}</Th><Th>{tf("settlement.label")}</Th>
          </tr></thead>
            <tbody>{data.items.map((e) => <Tr key={`${e.eventId}|${e.currency}`} className="group">
              <Td className="sticky start-0 z-10 min-w-56 bg-surface group-hover:bg-surface-2"><Link href={`/accounting/events/${e.eventId}`} className="font-medium underline-offset-4 hover:underline">{e.eventName}</Link>
                <span className="block text-xs text-muted"><code>{e.eventCode}</code>{e.startsOn ? ` · ${e.startsOn}` : ""} · <span className="uppercase">{e.currency}</span>{e.eventStatus !== "ACTIVE" ? <> · <Badge s={e.eventStatus} /></> : null}</span></Td>
              <Td className="whitespace-nowrap">{e.organiserId ? <Link href={`/accounting/organisers/${e.organiserId}`} className="underline-offset-4 hover:underline">{e.organiserName}</Link> : <span className="text-muted">—</span>}</Td>
              <Td className="text-end tabular-nums">{e.tickets.toLocaleString(locale)}</Td>
              <Td className="text-end"><Money v={e.grossSales} c={e.currency} /></Td>
              <Td className="text-end">{e.refunds + e.chargebacks ? <Money v={-(e.refunds + e.chargebacks)} c={e.currency} className="text-fin-neg" /> : <span className="text-muted">—</span>}{e.bookingFeesRefunded > 0 && <span className="block text-xs text-fin-warn">{tf("events.feeRecover")} <Money v={e.bookingFeesRefunded} c={e.currency} /></span>}</Td>
              <Td className="text-end"><Money v={e.netSales} c={e.currency} /></Td>
              <Td className="text-end"><Money v={e.bookingFees} c={e.currency} className="text-fin-pos" /><span className="block text-xs text-muted">{pct(e.bookingFeeBps)}</span></Td>
              <Td className="text-end"><Money v={e.processingFees} c={e.currency} />{e.feesRecharged > 0 && <span className="block text-xs text-muted">{tf("events.recharged")}</span>}</Td>
              <Td className="text-end">{e.expensesBilit + e.expensesOrganiser ? <Money v={e.expensesBilit + e.expensesOrganiser} c={e.currency} /> : <span className="text-muted">—</span>}</Td>
              <Td className="text-end"><Money v={e.organiserDue} c={e.currency} /></Td>
              <Td className="text-end"><Money v={e.organiserPaid} c={e.currency} /></Td>
              <Td className="text-end"><Money v={e.remaining} c={e.currency} strong className={e.remaining > 0 ? "text-fin-warn" : e.remaining < 0 ? "text-fin-neg" : ""} /></Td>
              <Td className="text-end"><Money v={e.bilitProfit} c={e.currency} strong className={e.bilitProfit < 0 ? "text-fin-neg" : "text-fin-pos"} /></Td>
              <Td><SettlementBadge s={e.settlement} /></Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {imp && <ImportEventsDialog onClose={() => setImp(false)} onSaved={() => void reload()} />}
      {open && <EventDialog open={open} onClose={() => setOpen(false)} onSaved={(id) => router.push(`/accounting/events/${id}`)} />}
    </div>
  );
}
