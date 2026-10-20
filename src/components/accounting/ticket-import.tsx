"use client";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import { Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { formatMoney } from "@/lib/money";

type TypeLine = { type: string; tickets: number; paid: number; free: number; price: number; fee: number };
type Summary = {
  currency: string; tickets: number; paidTickets: number; freeTickets: number; checkedIn: number; orders: number; paidOrders: number;
  ticketPrice: number; bookingFees: number; customersPaid: number; addOnTickets: number; addOnAmount: number; byType: TypeLine[]; feeRates: Array<{ pct: string; tickets: number }>;
  stripeSales: number; stripeAmount: number; matchedOrders: number; siteOnly: Array<{ order: string; total: number }>; stripeOnly: Array<{ order: string | null; amount: number }>;
  amountLow: Array<{ order: string; site: number; stripe: number }>; refunded: string[]; bookedFee: number; targetFee: number; correction: number; eventNames: string[];
};
type Item = { id: string; status: string; fileName: string | null; summary: Summary; appliedAmount: number | null; createdAt: string; appliedAt: string | null };
type Preview = { id: string; fileName: string | null; summary: Summary; applied: number };

/** Event tab: upload the ticket system's CSV export, see the breakdown and Stripe match, apply the booking-fee correction. */
export function TicketImportTab({ eventId, eventName, manage, onApplied }: { eventId: string; eventName: string; manage: boolean; onApplied: () => Promise<unknown> }) {
  const t = useTranslations("accounting.tix");
  const locale = useLocale();
  const toast = useToast();
  const { q } = useMode();
  const { data, loading, reload } = useApi<{ items: Item[]; applied: Item | null }>(q(`/api/accounting/events/${eventId}/tickets`));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (file: File) => {
    setBusy(true);
    try { const form = new FormData(); form.append("file", file); setPreview(await api<Preview>(q(`/api/accounting/events/${eventId}/tickets`), { form })); await reload(); }
    catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const shown: { s: Summary; fileName: string | null; applied: boolean; prior: number } | null = preview
    ? { s: preview.summary, fileName: preview.fileName, applied: false, prior: preview.applied }
    : data?.applied ? { s: data.applied.summary, fileName: data.applied.fileName, applied: true, prior: data.applied.appliedAmount ?? 0 } : null;
  const c = shown?.s.currency ?? "eur";
  const delta = shown ? shown.s.correction - shown.prior : 0;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("title")} description={t("desc")} action={manage && <>
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label={t("choose")} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => input.current?.click()}><Upload className="size-4" aria-hidden />{busy ? t("reading") : t("upload")}</Button></>} />
        {loading && !data ? <div className="p-5"><Skeleton className="h-24" /></div> : !shown ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-center gap-2 text-sm"><FileSpreadsheet className="size-4 text-muted" aria-hidden /><span className="font-medium">{shown.fileName ?? "CSV"}</span>
              <span className={shown.applied ? "rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-xs" : "rounded-full border border-line-strong px-2 py-0.5 text-xs"}>{shown.applied ? t("applied") : t("preview")}</span></div>
            {shown.s.eventNames.length > 0 && !shown.s.eventNames.some((n) => n.trim().toLowerCase() === eventName.trim().toLowerCase()) &&
              <Callout tone="warn" title={t("otherEvent")}>{shown.s.eventNames.join(", ")}</Callout>}
            {/* Headline figures */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label={t("k.tickets")} value={String(shown.s.tickets)} sub={t("k.ticketsSub", { paid: shown.s.paidTickets, free: shown.s.freeTickets })} />
              <Stat label={t("k.ticketPrice")} value={<Money v={shown.s.ticketPrice + shown.s.addOnAmount} c={c} strong />} sub={shown.s.addOnAmount ? t("k.withAddOns", { amount: fmt(shown.s.addOnAmount, c, locale) }) : t("k.organiserMoney")} />
              <Stat label={t("k.bookingFees")} value={<Money v={shown.s.bookingFees} c={c} strong />} sub={shown.s.feeRates.map((r) => `${r.pct} × ${r.tickets}`).join(" · ")} />
              <Stat label={t("k.paid")} value={<Money v={shown.s.customersPaid + shown.s.addOnAmount} c={c} strong />} sub={t("k.stripe", { amount: fmt(shown.s.stripeAmount, c, locale), n: shown.s.stripeSales })} />
            </div>
            {/* Correction */}
            <div className="rounded-xl border border-line p-4">
              <h3 className="font-semibold">{t("fix.title")}</h3>
              <dl className="mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
                <dt className="text-muted">{t("fix.booked", { n: shown.s.matchedOrders })}</dt><dd className="text-end"><Money v={shown.s.bookedFee} c={c} /></dd>
                <dt className="text-muted">{t("fix.charged")}</dt><dd className="text-end"><Money v={shown.s.targetFee} c={c} /></dd>
                <dt className="font-medium">{shown.s.correction >= 0 ? t("fix.toOrganiser") : t("fix.toBilit")}</dt><dd className="text-end font-semibold"><Money v={Math.abs(shown.s.correction)} c={c} /></dd>
                {shown.prior !== 0 && !shown.applied && <><dt className="text-muted">{t("fix.already")}</dt><dd className="text-end"><Money v={shown.prior} c={c} /></dd></>}
              </dl>
              {!shown.applied && manage && preview && <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="primary" disabled={busy} onClick={() => setConfirm(true)}><CheckCircle2 className="size-4" aria-hidden />{delta === 0 ? t("fix.applyNoChange") : t("fix.apply", { amount: fmt(Math.abs(delta), c, locale) })}</Button>
                <span className="text-xs text-muted">{t("fix.note")}</span></div>}
              {shown.applied && <p className="mt-3 text-sm font-medium">{t("fix.done")}</p>}
            </div>
            {/* Checks */}
            {(shown.s.siteOnly.length + shown.s.stripeOnly.length + shown.s.amountLow.length + shown.s.refunded.length) > 0 && (
              <Callout tone="warn" title={t("checks.title")}><ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                {shown.s.siteOnly.length > 0 && <li>{t("checks.siteOnly", { n: shown.s.siteOnly.length })}: {shown.s.siteOnly.map((x) => `${x.order} (${fmt(x.total, c, locale)})`).join(", ")}</li>}
                {shown.s.stripeOnly.length > 0 && <li>{t("checks.stripeOnly", { n: shown.s.stripeOnly.length })}: {shown.s.stripeOnly.map((x) => `${x.order ?? t("checks.noRef")} (${fmt(x.amount, c, locale)})`).join(", ")}</li>}
                {shown.s.amountLow.length > 0 && <li>{t("checks.amountLow", { n: shown.s.amountLow.length })}: {shown.s.amountLow.map((x) => `${x.order} (${fmt(x.site, c, locale)} / ${fmt(x.stripe, c, locale)})`).join(", ")}</li>}
                {shown.s.refunded.length > 0 && <li>{t("checks.refunded", { n: shown.s.refunded.length })}: {shown.s.refunded.join(", ")}</li>}
              </ul></Callout>)}
            {/* By ticket type */}
            <TableWrap><Table><thead><tr><Th>{t("type.type")}</Th><Th className="text-end">{t("type.tickets")}</Th><Th className="text-end">{t("type.free")}</Th><Th className="text-end">{t("type.price")}</Th><Th className="text-end">{t("type.fee")}</Th></tr></thead>
              <tbody>{shown.s.byType.map((x) => <Tr key={x.type}><Td className="font-medium">{x.type}</Td><Td className="text-end">{x.tickets}</Td><Td className="text-end">{x.free}</Td><Td className="text-end"><Money v={x.price} c={c} /></Td><Td className="text-end"><Money v={x.fee} c={c} /></Td></Tr>)}
                {shown.s.addOnAmount > 0 && <Tr><Td className="font-medium">{t("type.addOns")}</Td><Td className="text-end">{shown.s.addOnTickets}</Td><Td /><Td className="text-end"><Money v={shown.s.addOnAmount} c={c} /></Td><Td /></Tr>}
              </tbody></Table></TableWrap>
          </div>)}
      </Card>
      {(data?.items.length ?? 0) > 0 && <Card><CardHeader title={t("history")} />
        <TableWrap><Table><thead><tr><Th>{t("h.date")}</Th><Th>{t("h.file")}</Th><Th>{t("h.status")}</Th><Th className="text-end">{t("h.correction")}</Th></tr></thead>
          <tbody>{data!.items.map((x) => <Tr key={x.id}><Td className="whitespace-nowrap">{fmtDate(x.createdAt, locale)}</Td><Td>{x.fileName ?? "—"}</Td><Td>{t(`status.${x.status}`)}</Td><Td className="text-end"><Money v={x.summary.correction} c={x.summary.currency} /></Td></Tr>)}</tbody></Table></TableWrap></Card>}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t("fix.confirmTitle")} description={t("fix.confirmDesc")} confirmLabel={t("fix.confirm")}
        onConfirm={async () => {
          try { const r = await api<{ delta: number }>(q(`/api/accounting/events/${eventId}/tickets/${preview!.id}/apply`), { json: {} }); toast("ok", t("fix.toast", { amount: fmt(Math.abs(r.delta), c, locale) })); setPreview(null); await Promise.all([reload(), onApplied()]); }
          catch (e) { toast("error", errMsg(e)); throw e; }
        }} />
    </div>
  );
}

const fmt = (v: number, c: string, locale: string) => formatMoney(v, c, locale);

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return <div className="rounded-xl border border-line p-4"><div className="text-xs text-muted">{label}</div><div className="mt-1 text-lg">{value}</div>{sub && <div className="mt-1 text-xs text-muted">{sub}</div>}</div>;
}

