"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout } from "@/components/ui/feedback";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate } from "@/lib/api";
import { cn } from "@/components/ui/cn";
import { StripeNav } from "../nav";

type Line = { chargeId: string; date: string; order: string | null; eventCode: string | null; eventId: string | null; eventName: string | null; customer: string | null; currency: string; amount: number; refunded: number; fee: number; bookingFee: number | null; organiserShare: number | null; status: string };
type Total = { currency: string; payments: number; amount: number; refunded: number; fee: number; bookingFee: number; organiserShare: number };
type Result = { lines: Line[]; totals: Total[]; counts: Record<string, number>; booked?: number; failed?: Array<{ chargeId: string; error: string }> };

const TONE: Record<string, string> = { NEW: "border-accent bg-accent-soft", ALREADY_IMPORTED: "border-line-strong text-muted", IN_MAIN_STRIPE: "border-line-strong text-muted", BOOKED_BY_HAND: "border-line-strong text-muted", NOT_PAID: "border-line-strong text-muted" };

/** Upload the Payments export of Bilit's other (old) Stripe account and book its sales on the right events. */
export default function OtherStripePage() {
  const t = useTranslations("accounting.otherStripe");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const { q } = useMode();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null); const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false); const [over, setOver] = useState(false); const [confirm, setConfirm] = useState(false);
  const send = async (f: File, apply: boolean) => {
    setBusy(true);
    try {
      const form = new FormData(); form.append("file", f); if (apply) form.append("apply", "1");
      const r = await api<Result>(q("/api/accounting/stripe/other-import"), { form });
      setFile(f); setRes(r);
      if (apply) toast(r.failed?.length ? "error" : "ok", t("booked", { n: r.booked ?? 0, failed: r.failed?.length ?? 0 }));
    } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const pick = (f: File | undefined) => { if (!f) return; if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") { toast("error", t("notCsv")); return; } void send(f, false); };
  const manage = can("accounting.manage");
  const nNew = res?.counts.NEW ?? 0;
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <StripeNav />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("uploadTitle")} description={t("uploadDesc")} />
          <div className="space-y-4 p-5">
            <ol className="list-decimal space-y-1 ps-5 text-sm text-muted"><li>{t("step1")}</li><li>{t("step2")}</li><li>{t("step3")}</li></ol>
            {manage ? <>
              <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label={t("choose")} onChange={(e) => pick(e.target.files?.[0])} />
              <div role="button" tabIndex={0} aria-label={t("drop")} aria-busy={busy}
                onClick={() => !busy && input.current?.click()} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !busy) { e.preventDefault(); input.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) pick(e.dataTransfer.files?.[0]); }}
                className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors", over ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface-2")}>
                <FileSpreadsheet className="size-8 text-muted" aria-hidden />
                <p className="font-medium">{busy ? t("reading") : file ? file.name : t("drop")}</p>
                <p className="text-xs text-muted">{t("dropHint")}</p>
              </div>
            </> : <Callout>{t("noPermission")}</Callout>}
          </div>
        </Card>

        {res && <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {res.totals.map((x) => (
              <Card key={x.currency} className="space-y-2 p-4">
                <p className="text-xs uppercase text-muted">{t("toBook", { n: x.payments, c: x.currency.toUpperCase() })}</p>
                <p className="text-xl font-semibold"><Money v={x.amount} c={x.currency} /></p>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-muted">{t("col.bookingFee")}</dt><dd><Money v={x.bookingFee} c={x.currency} /></dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">{t("col.organiser")}</dt><dd><Money v={x.organiserShare} c={x.currency} strong /></dd></div>
                  {x.refunded > 0 && <div className="flex justify-between gap-2"><dt className="text-muted">{t("col.refunded")}</dt><dd><Money v={x.refunded} c={x.currency} /></dd></div>}
                  <div className="flex justify-between gap-2"><dt className="text-muted">{t("col.fee")}</dt><dd><Money v={x.fee} c={x.currency} /></dd></div>
                </dl>
              </Card>
            ))}
            {!res.totals.length && <Callout tone="ok" icon={<CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />}>{t("nothingNew")}</Callout>}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">{Object.entries(res.counts).filter(([, n]) => n > 0).map(([k, n]) => <span key={k} className={cn("rounded-full border px-2 py-0.5", TONE[k] ?? "border-fin-warn/40 text-fin-warn")}>{t(`s.${k}`)}: {n}</span>)}</div>
          {res.failed && res.failed.length > 0 && <Callout tone="warn" title={t("failedTitle")}>{res.failed.map((f) => <p key={f.chargeId} className="text-sm"><code>{f.chargeId}</code>: {f.error}</p>)}</Callout>}
          {manage && nNew > 0 && file && <div><Button variant="primary" loading={busy} onClick={() => setConfirm(true)}><Upload className="size-4" aria-hidden />{t("apply", { n: nNew })}</Button></div>}
          <Card>
            <TableWrap><Table><thead><tr><Th>{t("col.date")}</Th><Th>{t("col.order")}</Th><Th>{t("col.event")}</Th><Th className="text-end">{t("col.amount")}</Th><Th className="text-end">{t("col.bookingFee")}</Th><Th className="text-end">{t("col.organiser")}</Th><Th>{t("col.status")}</Th></tr></thead>
              <tbody>{res.lines.map((l) => <Tr key={l.chargeId} className={l.status === "NEW" ? "" : "text-muted"}>
                <Td className="whitespace-nowrap">{fmtDate(`${l.date}T12:00:00Z`, locale)}</Td>
                <Td><span className="font-medium">{l.order ?? "—"}</span>{l.customer && <span className="block max-w-48 truncate text-xs text-muted">{l.customer}</span>}<code className="block text-[11px] text-muted">{l.chargeId}</code></Td>
                <Td>{l.eventId ? <Link href={`/accounting/events/${l.eventId}`} className="underline-offset-4 hover:underline">{l.eventCode}</Link> : (l.eventCode ?? "—")}{l.eventName && <span className="block max-w-56 truncate text-xs text-muted">{l.eventName}</span>}</Td>
                <Td className="text-end"><Money v={l.amount} c={l.currency} strong />{l.refunded > 0 && <span className="block text-xs text-fin-neg">−<Money v={l.refunded} c={l.currency} /></span>}</Td>
                <Td className="text-end">{l.bookingFee == null ? "—" : <Money v={l.bookingFee} c={l.currency} />}</Td>
                <Td className="text-end">{l.organiserShare == null ? "—" : <Money v={l.organiserShare - l.refunded} c={l.currency} />}</Td>
                <Td><span className={cn("rounded-full border px-2 py-0.5 text-xs", TONE[l.status] ?? "border-fin-warn/40 text-fin-warn")}>{t(`s.${l.status}`)}</span></Td>
              </Tr>)}</tbody></Table></TableWrap>
          </Card>
        </>}
        <Callout title={t("howTitle")}>{t("how")}</Callout>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t("confirmTitle", { n: nNew })} description={t("confirmDesc")} confirmLabel={t("apply", { n: nNew })}
        onConfirm={async () => { if (file) await send(file, true); }} />
    </div>
  );
}
