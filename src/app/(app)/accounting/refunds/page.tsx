"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarPlus, CheckCircle2, FileDown, Link2, Search, Undo2, Unlink } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge, Money, RangePicker, rangeFor, rangeQuery, useMode, type RangeKey } from "@/components/accounting/kit";
import { ImportEventsDialog } from "@/components/accounting/forms";
import { MatchDialog } from "@/components/accounting/match";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { fmtDate, useApi } from "@/lib/api";

type Row = { id: string; kind: string; date: string; amount: number; currency: string; linked: boolean; matchReason: string | null; eventId: string | null; eventCode: string | null; eventName: string | null; saleId: string | null; saleAmount: number; saleFee: number; saleLinked: boolean; customerName: string | null; customerEmail: string | null; description: string | null; refundStatus: string | null; reason: string | null; note: string | null; failureReason: string | null; feeRefunded: number | null; feeKeptByBilit: boolean };
type Resp = { items: Row[]; total: number; page: number; pageSize: number; totals: Array<{ currency: string; count: number; amount: number; linked: number; unlinkedAmount: number }>; unlinkedGroups: Array<{ code: string | null; currency: string; count: number; amount: number; eventName: string | null; eventExists: boolean }> };
type FeeTotals = { totals: Array<{ currency: string; bookingFeesRefunded: number }> };
type EvRow = { eventId: string; eventName: string; eventCode: string; eventStatus: string; organiserId: string | null; organiserName: string | null; currency: string; refunds: number; chargebacks: number; bookingFeesRefunded: number; feesRecharged: number; remaining: number };

/** Per organiser: events whose refunds included booking fee, which the organiser must pay back (policy: fee non-refundable). */
function FeeRecovery({ rows }: { rows: EvRow[] }) {
  const t = useTranslations("accounting.refunds.recover");
  const { q: withMode } = useMode();
  const by = new Map<string, { name: string; organiserId: string | null; currency: string; events: EvRow[]; balance: number }>();
  for (const r of rows) {
    const k = `${r.organiserId}|${r.currency}`;
    const g = by.get(k) ?? { name: r.organiserName ?? "—", organiserId: r.organiserId, currency: r.currency, events: [], balance: 0 };
    g.balance += r.remaining;
    if (r.bookingFeesRefunded > 0) g.events.push(r);
    by.set(k, g);
  }
  const groups = [...by.values()].filter((g) => g.events.length).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Card>
      <CardHeader title={t("title")} description={t("desc")} />
      {!groups.length ? <p className="px-5 py-4 text-sm text-muted">{t("none")}</p> : groups.map((g) => {
        const fee = g.events.reduce((s, e) => s + e.bookingFeesRefunded, 0);
        return <div key={`${g.organiserId}|${g.currency}`} className="border-t border-line first:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
            <h3 className="font-semibold">{g.organiserId ? <Link href={`/accounting/organisers/${g.organiserId}`} className="underline-offset-4 hover:underline">{g.name}</Link> : g.name} <span className="text-xs font-normal uppercase text-muted">{g.currency}</span></h3>
            <span className="flex flex-wrap items-center gap-3 text-sm">{g.organiserId && <a href={withMode(`/api/accounting/refunds/pdf?organiserId=${g.organiserId}`)} className="inline-flex items-center gap-1 underline underline-offset-4"><FileDown className="size-3.5" aria-hidden />{t("pdf")}</a>}<span><span className="text-muted">{t("balance")}: </span><Money v={g.balance} c={g.currency} strong className={g.balance < 0 ? "text-fin-neg" : ""} /> <span className="text-xs text-muted">{g.balance < 0 ? t("owes") : t("owed")}</span></span></span>
          </div>
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr><Th>{t("event")}</Th><Th>{t("status")}</Th><Th className="text-end">{t("refunded")}</Th><Th className="text-end">{t("fee")}</Th><Th className="text-end">{t("stripe")}</Th></tr></thead>
            <tbody>{g.events.map((e) => <Tr key={e.eventId}><Td><Link href={`/accounting/events/${e.eventId}`} className="font-medium underline-offset-4 hover:underline">{e.eventName}</Link> <code className="text-xs text-muted">{e.eventCode}</code></Td>
              <Td><Badge s={e.eventStatus} /></Td><Td className="text-end"><Money v={e.refunds + e.chargebacks} c={e.currency} /></Td><Td className="text-end"><Money v={e.bookingFeesRefunded} c={e.currency} strong className="text-fin-warn" /></Td><Td className="text-end">{e.feesRecharged ? <Money v={e.feesRecharged} c={e.currency} /> : <span className="text-muted">—</span>}</Td></Tr>)}
              <Tr><Td className="font-semibold" colSpan={3}>{t("total", { name: g.name })}</Td><Td className="text-end"><Money v={fee} c={g.currency} strong className="text-fin-warn" /></Td><Td /></Tr></tbody></Table></TableWrap>
        </div>;
      })}
    </Card>
  );
}

/** Refunds & chargebacks: totals, what is not yet linked to an event (and how to fix it), and every refund in detail. */
export default function RefundsPage() {
  const t = useTranslations("accounting.refunds");
  const locale = useLocale();
  const { can } = useMe();
  const { q: withMode } = useMode();
  const [linked, setLinked] = useState<"" | "yes" | "no">(""); const [q, setQ] = useState(""); const [page, setPage] = useState(1);
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const [imp, setImp] = useState(false); const [match, setMatch] = useState<Row | null>(null);
  const dq = useDebounced(q, 300);
  const { data, loading, reload } = useApi<Resp>(withMode(`/api/accounting/refunds?page=${page}&pageSize=50${linked ? `&linked=${linked}` : ""}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${rangeQuery(rangeFor(range.key, range))}`));
  const fees = useApi<FeeTotals & { items: EvRow[] }>(withMode("/api/accounting/finance/events?pageSize=200"));
  const manage = can("accounting.manage");
  // Linking the original sale links its refunds too; only refunds without a sale are linked on their own.
  const target = (r: Row) => ({ id: r.saleId && !r.saleLinked ? r.saleId : r.id, kind: r.saleId && !r.saleLinked ? "SALE" : r.kind, balanceTransactionId: "", amount: r.saleId && !r.saleLinked ? r.saleAmount : -r.amount, currency: r.currency, description: r.description, eventCode: r.eventCode, eventId: r.eventId });
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("sub")} actions={<a href={withMode(`/api/accounting/refunds/pdf?x=1${rangeQuery(rangeFor(range.key, range))}`)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong px-4 text-sm font-medium hover:bg-surface-2"><FileDown className="size-4" aria-hidden />{t("pdfAll")}</a>} />
      {data && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{data.totals.map((x) => {
        const fr = fees.data?.totals.find((f) => f.currency === x.currency)?.bookingFeesRefunded ?? 0;
        return <Card key={x.currency} className="p-4 text-sm"><p className="text-xs font-semibold uppercase text-muted">{x.currency}</p>
          <p className="mt-1 text-2xl font-semibold text-fin-neg"><Money v={x.amount} c={x.currency} /></p><p className="text-xs text-muted">{t("refundedCount", { n: x.count })}</p>
          <p className="mt-2 flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-fin-pos" aria-hidden />{t("linkedOf", { n: x.linked, total: x.count })}</p>
          {x.unlinkedAmount > 0 && <p className="flex items-center gap-1.5 text-fin-warn"><Unlink className="size-3.5" aria-hidden />{t("unlinkedAmount")} <Money v={x.unlinkedAmount} c={x.currency} /></p>}
          {fr > 0 && <p className="mt-1 text-xs"><span className="text-muted">{t("feeRecover")}: </span><Money v={fr} c={x.currency} className="font-medium" /></p>}</Card>;
      })}</div>}

      {fees.data && <FeeRecovery rows={fees.data.items} />}

      {data && data.unlinkedGroups.length > 0 && <Card>
        <CardHeader title={t("unlinkedTitle")} description={t("unlinkedDesc")} action={manage && <Button size="sm" variant="primary" onClick={() => setImp(true)}><CalendarPlus className="size-4" aria-hidden />{t("createEvents")}</Button>} />
        <ul className="divide-y divide-line">{data.unlinkedGroups.map((g) => <li key={`${g.code}|${g.currency}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
          <span><code className="font-semibold">{g.code ?? t("noCode")}</code>{g.eventName && <span className="ms-2">{g.eventName}</span>}
            <span className="block text-xs text-muted">{g.eventExists ? t("eventExistsHint") : t("noEventHint")}</span></span>
          <span className="flex items-center gap-3"><span className="text-muted">{t("nRefunds", { n: g.count })}</span><Money v={g.amount} c={g.currency} strong /></span></li>)}</ul>
      </Card>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-line-strong p-0.5 text-sm">{(["", "yes", "no"] as const).map((k) => <button key={k} type="button" onClick={() => { setLinked(k); setPage(1); }} className={cn("rounded-lg px-3 py-1.5", linked === k ? "bg-fg text-bg" : "text-muted hover:text-fg")}>{t(`f.${k || "all"}`)}</button>)}</div>
        <div className="relative min-w-56 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} keys={["all", "month", "lastMonth", "year", "custom"]} />
      </div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState icon={<Undo2 className="size-6" aria-hidden />} title={t("empty")} /> : <>
          <TableWrap><Table className="text-[13px] [&_td]:px-3 [&_th]:px-3"><thead><tr><Th>{t("date")}</Th><Th>{t("customer")}</Th><Th>{t("event")}</Th><Th className="text-end">{t("amount")}</Th><Th className="text-end">{t("originalSale")}</Th><Th className="text-end">{t("feePart")}</Th><Th>{t("stripeStatus")}</Th><Th>{t("reason")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((r) => <Tr key={r.id}>
              <Td className="whitespace-nowrap"><Link href={`/accounting/transactions/${r.id}`} className="underline-offset-4 hover:underline">{fmtDate(r.date, locale, { dateStyle: "medium" })}</Link>{r.kind === "DISPUTE" && <span className="block text-xs text-fin-neg">{t("chargeback")}</span>}</Td>
              <Td className="min-w-40"><span className="font-medium">{r.customerName ?? "—"}</span><span className="block text-xs text-muted">{r.customerEmail}</span></Td>
              <Td className="min-w-48">{r.linked && r.eventId ? <Link href={`/accounting/events/${r.eventId}`} className="font-medium underline-offset-4 hover:underline">{r.eventName}</Link> : <span className="inline-flex items-center gap-1 text-fin-warn"><Unlink className="size-3.5" aria-hidden />{t("notLinked")}</span>}
                <span className="block text-xs text-muted">{r.eventCode ?? "—"}</span></Td>
              <Td className="text-end"><Money v={r.amount} c={r.currency} strong className="text-fin-neg" /></Td>
              <Td className="text-end">{r.saleId ? <Money v={r.saleAmount} c={r.currency} /> : "—"}{r.saleFee > 0 && <span className="block text-xs text-muted">{t("incFee")} <Money v={r.saleFee} c={r.currency} /></span>}</Td>
              <Td className="text-end">{r.feeRefunded == null ? <span className="text-muted">—</span> : r.feeRefunded > 0 ? <span className="text-fin-warn"><Money v={r.feeRefunded} c={r.currency} /><span className="block text-xs">{t("chargedToOrganiser")}</span></span> : <span className="text-xs text-fin-pos">{t("ticketOnly")}</span>}</Td>
              <Td>{r.refundStatus ?? "—"}{r.failureReason && <span className="block text-xs text-fin-neg">{r.failureReason}</span>}</Td>
              <Td className="max-w-48 text-xs">{r.reason?.replace(/_/g, " ") ?? "—"}{r.note && <span className="block text-muted">{r.note}</span>}</Td>
              <Td className="text-end">{manage && !r.linked && <Button size="sm" onClick={() => setMatch(r)}><Link2 className="size-3.5" aria-hidden />{t("link")}</Button>}</Td>
            </Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      <p className="text-xs text-muted">{t("help")}</p>
      {imp && <ImportEventsDialog onClose={() => setImp(false)} onSaved={() => { void reload(); void fees.reload(); }} />}
      <MatchDialog tx={match ? target(match) : null} open={!!match} onClose={() => setMatch(null)} onDone={() => { void reload(); void fees.reload(); }} />
    </div>
  );
}
