"use client";
import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleMinus, Paperclip, TrendingUp } from "lucide-react";
import { Money } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Callout } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, fmtDate, useApi } from "@/lib/api";
import { bpsToPercent, formatMoney, parseMajor, percentToBps, toDecimalString } from "@/lib/money";

/** Figures for one event (or organiser) and currency, as calculated by server/accounting/finance.ts. */
export type Fig = {
  currency: string; tickets: number; orders: number; grossSales: number; refunds: number; chargebacks: number; netSales: number;
  bookingFees: number; eventFees: number; otherRevenue: number; bilitRevenue: number; processingFees: number; feesRecharged: number; bilitProcessingFees: number;
  organiserShare: number; deductions: number; expensesBilit: number; expensesOrganiser: number; otherCosts: number;
  organiserDue: number; organiserPaid: number; remaining: number; pendingPayments: number; bilitProfit: number; settlement: Settlement;
};
export type Settlement = "NOTHING_DUE" | "NOT_SETTLED" | "PARTIALLY_PAID" | "FULLY_PAID" | "OVERPAID";
export const SETTLEMENTS: Settlement[] = ["NOT_SETTLED", "PARTIALLY_PAID", "FULLY_PAID", "OVERPAID", "NOTHING_DUE"];

type FieldErrors = Record<string, string>;
const fieldErrors = (e: unknown): FieldErrors => (e instanceof ApiError && Array.isArray(e.details) ? Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])) : {});
export const pct = (bps: number | null | undefined) => (bps == null ? "—" : `${bpsToPercent(bps)} %`);

// ---------- settlement status ----------
const ST: Record<Settlement, { cls: string; Icon: typeof CheckCircle2 }> = {
  NOT_SETTLED: { cls: "border-fin-warn/40 bg-fin-warn/12 text-fin-warn", Icon: CircleDashed },
  PARTIALLY_PAID: { cls: "border-fin-info/40 bg-fin-info/12 text-fin-info", Icon: TrendingUp },
  FULLY_PAID: { cls: "border-fin-pos/40 bg-fin-pos/12 text-fin-pos", Icon: CheckCircle2 },
  OVERPAID: { cls: "border-fin-neg/40 bg-fin-neg/12 text-fin-neg", Icon: AlertTriangle },
  NOTHING_DUE: { cls: "border-line-strong text-muted", Icon: CircleMinus },
};
/** Status always carries an icon and a label, never colour alone. */
export function SettlementBadge({ s, className }: { s: Settlement; className?: string }) {
  const t = useTranslations("accounting.fin.settlement");
  const { cls, Icon } = ST[s];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", cls, className)}><Icon className="size-3.5" aria-hidden />{t(s)}</span>;
}

/** Due → paid progress with the settlement status (the "how much is left" summary). */
export function SettlementSummary({ f }: { f: Fig }) {
  const t = useTranslations("accounting.fin");
  const share = f.organiserDue > 0 ? Math.min(100, Math.max(0, (f.organiserPaid / f.organiserDue) * 100)) : f.organiserPaid > 0 ? 100 : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm text-muted">{t("settlement.label")}</span><SettlementBadge s={f.settlement} /></div>
      <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)} aria-label={t("paidShare")}>
        <div className={cn("h-full rounded-full", f.settlement === "OVERPAID" ? "bg-fin-neg" : "bg-fin-pos")} style={{ width: `${share}%` }} />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-muted">{t("k.organiserDue")}</dt><dd className="font-semibold"><Money v={f.organiserDue} c={f.currency} /></dd></div>
        <div><dt className="text-xs text-muted">{t("k.organiserPaid")}</dt><dd className="font-semibold"><Money v={f.organiserPaid} c={f.currency} /></dd></div>
        <div><dt className="text-xs text-muted">{t("k.remaining")}</dt><dd className={cn("font-semibold", f.remaining < 0 ? "text-fin-neg" : f.remaining > 0 ? "text-fin-warn" : "text-fin-pos")}><Money v={f.remaining} c={f.currency} /></dd></div>
      </dl>
      {f.pendingPayments > 0 && <p className="text-xs text-muted">{t("pendingNote")}: <Money v={f.pendingPayments} c={f.currency} /></p>}
    </div>
  );
}

// ---------- statements ----------
type Line = { label: string; v: number; sign?: "+" | "-"; total?: boolean; muted?: boolean; hint?: string };
/** A ledger-style statement: signed lines, totals ruled off. Amounts carry their sign as text, not colour only. */
export function Statement({ lines, currency, caption }: { lines: Line[]; currency: string; caption?: string }) {
  return (
    <table className="w-full text-sm">
      {caption && <caption className="sr-only">{caption}</caption>}
      <tbody>{lines.map((l, i) => (
        <tr key={i} className={cn(l.total ? "border-t-2 border-fg/70 font-semibold" : "border-b border-line", l.muted && "text-muted")}>
          <th scope="row" className={cn("py-2.5 pe-3 text-start", l.total ? "font-semibold" : "font-normal")}>{l.label}{l.hint && <span className="block text-xs font-normal text-muted">{l.hint}</span>}</th>
          <td className={cn("py-2.5 text-end tabular-nums", l.total && (l.v < 0 ? "text-fin-neg" : "text-fin-pos"))}>
            {l.sign === "-" && l.v !== 0 ? <span aria-hidden>−</span> : l.sign === "+" && l.v !== 0 ? <span aria-hidden>+</span> : null}<Money v={l.sign === "-" ? Math.abs(l.v) : l.v} c={currency} strong={l.total} />
          </td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** Customer money → organiser money → Bilit money, for one currency. */
export function moneyFlow(f: Fig, t: (k: string) => string): Line[] {
  return [
    { label: t("k.grossSales"), v: f.grossSales },
    { label: t("k.refunds"), v: f.refunds, sign: "-" },
    { label: t("k.chargebacks"), v: f.chargebacks, sign: "-", muted: !f.chargebacks },
    { label: t("k.netSales"), v: f.netSales, total: true },
    { label: t("k.bookingFees"), v: f.bookingFees, sign: "-", hint: t("flow.bookingHint") },
    { label: t("k.feesRecharged"), v: f.feesRecharged, sign: "-", muted: !f.feesRecharged },
    { label: t("k.deductions"), v: f.deductions, sign: "-", muted: !f.deductions, hint: t("flow.deductionsHint") },
    { label: t("k.organiserDue"), v: f.organiserDue, total: true },
    { label: t("k.organiserPaid"), v: f.organiserPaid, sign: "-" },
    { label: t("k.remaining"), v: f.remaining, total: true },
  ];
}

/** Bilit's profit & loss for the event (revenue − expense accounts in the ledger). */
export function profitAndLoss(f: Fig, t: (k: string) => string): Line[] {
  const other = f.bilitProfit - (f.bookingFees + f.eventFees + f.otherRevenue - f.bilitProcessingFees - f.expensesBilit - f.otherCosts);
  return [
    { label: t("k.grossSales"), v: f.grossSales, muted: true, hint: t("pl.grossHint") },
    { label: t("k.bookingFees"), v: f.bookingFees, sign: "+", hint: t("pl.bookingHint") },
    { label: t("k.eventFees"), v: f.eventFees, sign: "+", muted: !f.eventFees },
    { label: t("k.otherRevenue"), v: f.otherRevenue, sign: "+", muted: !f.otherRevenue },
    { label: t("k.processingFees"), v: f.processingFees, sign: "-" },
    { label: t("k.feesRecharged"), v: f.feesRecharged, sign: "+", muted: !f.feesRecharged },
    { label: t("k.expensesBilit"), v: f.expensesBilit, sign: "-", muted: !f.expensesBilit },
    { label: t("k.otherCosts"), v: f.otherCosts, sign: "-", muted: !f.otherCosts },
    ...(other !== 0 ? [{ label: t("pl.bilitBorne"), v: other, sign: (other < 0 ? "-" : "+") as "-" | "+", hint: t("pl.bilitBorneHint") }] : []),
    { label: t("k.bilitProfit"), v: f.bilitProfit, total: true },
  ];
}

// ---------- charts ----------
type Datum = { label: string; value: number; sub?: string };
/** Single-series column chart (one currency). Bars grow from a zero baseline, so losses hang below it. */
export function ColumnChart({ data, currency, caption, height = 200 }: { data: Datum[]; currency: string; caption: string; height?: number }) {
  const locale = useLocale();
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return null;
  const max = Math.max(0, ...data.map((d) => d.value)), min = Math.min(0, ...data.map((d) => d.value));
  const span = max - min || 1;
  const W = 640, H = height, top = 8, bottom = 22, plot = H - top - bottom;
  const y = (v: number) => top + ((max - v) / span) * plot;
  const bw = W / data.length, barW = Math.max(4, Math.min(36, bw - 6));
  const every = Math.ceil(data.length / 8);
  const fmt = (v: number) => formatMoney(v, currency, locale);
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="w-full overflow-visible" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{caption}</title>
        {[max, (max + min) / 2, min].map((v, i) => <line key={i} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : "3 4"} />)}
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth={1} />
        {data.map((d, i) => {
          const x = i * bw + (bw - barW) / 2, y0 = y(0), y1 = y(d.value), h = Math.max(1, Math.abs(y0 - y1));
          const neg = d.value < 0, r = Math.min(4, barW / 2, h);
          // Rounded data end, square at the baseline.
          const path = neg
            ? `M${x},${y0} h${barW} v${h - r} q0,${r} ${-r},${r} h${-(barW - 2 * r)} q${-r},0 ${-r},${-r} z`
            : `M${x},${y0} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`;
          return <g key={d.label}>
            <rect x={i * bw} y={0} width={bw} height={H - bottom} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
            <path d={path} className={neg ? "fill-fin-neg" : "fill-accent"} opacity={hover === null || hover === i ? 1 : 0.45} pointerEvents="none" />
            {i % every === 0 && <text x={i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{d.label}</text>}
          </g>;
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-card" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}>
          <div className="text-muted">{data[hover]!.label}{data[hover]!.sub ? ` · ${data[hover]!.sub}` : ""}</div><div className="font-semibold tabular-nums">{fmt(data[hover]!.value)}</div>
        </div>
      )}
      <table className="sr-only"><caption>{caption}</caption><tbody>{data.map((d) => <tr key={d.label}><th scope="row">{d.label}</th><td>{fmt(d.value)}</td></tr>)}</tbody></table>
    </figure>
  );
}

/** Ranked horizontal bars (HTML, so long names wrap on phones). Values are always printed as text. */
export function BarList({ data, currency, caption, href }: { data: Datum[]; currency: string; caption: string; href?: (i: number) => string }) {
  const locale = useLocale();
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <figure>
      <figcaption className="sr-only">{caption}</figcaption>
      <ul className="space-y-2.5">{data.map((d, i) => (
        <li key={`${d.label}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="truncate text-sm">{href ? <a href={href(i)} className="underline-offset-4 hover:underline">{d.label}</a> : d.label}{d.sub && <span className="ms-1.5 text-xs text-muted">{d.sub}</span>}</span>
          <span className={cn("text-sm font-medium tabular-nums", d.value < 0 && "text-fin-neg")}>{formatMoney(d.value, currency, locale)}</span>
          <span className="col-span-2 h-2 overflow-hidden rounded-full bg-surface-2"><span className={cn("block h-full rounded-full", d.value < 0 ? "bg-fin-neg" : "bg-accent")} style={{ width: `${(Math.abs(d.value) / max) * 100}%` }} /></span>
        </li>
      ))}</ul>
    </figure>
  );
}

// ---------- booking fee ----------
export function BookingFeeDialog({ eventId, currentBps, onClose, onSaved }: { eventId: string; currentBps: number | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.fin.fee");
  const c = useTranslations("common");
  const toast = useToast();
  const [v, setV] = useState(currentBps == null ? "" : bpsToPercent(currentBps));
  const [scope, setScope] = useState<"all" | "from" | "future">("all");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  let bps: number | null = null; try { bps = v.trim() ? percentToBps(v) : null; } catch { bps = null; }
  const submit = async () => {
    if (bps === null) { setErr(t("invalid")); return; }
    setBusy(true); setErr(null);
    try { const r = await api<{ reposted: number }>(`/api/accounting/events/${eventId}/booking-fee`, { json: { percentBps: bps, applyToExisting: scope !== "future", applyFrom: scope === "from" ? from : null, reason } }); toast("ok", t("saved", { n: r.reposted })); onSaved(); onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={t("title")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={bps === null || reason.trim().length < 3 || (scope === "from" && !from)} onClick={submit}>{t("save")}</Button></>}>
      <div className="space-y-4">
        <Field label={t("percent")} required hint={t("current", { v: pct(currentBps) })}>{(p) => <div className="flex items-center gap-2"><Input {...p} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} className="w-32 text-end font-semibold" placeholder="7.00" /><span className="text-lg font-semibold">%</span></div>}</Field>
        <fieldset className="space-y-2"><legend className="mb-1 text-sm font-medium">{t("scope")}</legend>
          {(["all", "from", "future"] as const).map((k) => <label key={k} className="flex items-start gap-2 rounded-lg border border-line p-2.5 text-sm has-[:checked]:border-accent">
            <input type="radio" name="fee-scope" className="mt-1" checked={scope === k} onChange={() => setScope(k)} />
            <span className="flex-1"><span className="font-medium">{t(`scopes.${k}`)}</span><span className="block text-xs text-muted">{t(`scopes.${k}Help`)}</span>
              {k === "from" && scope === "from" && <Input type="date" aria-label={t("scopes.date")} value={from} onChange={(e) => setFrom(e.target.value)} className="mt-2 w-auto" />}</span>
          </label>)}
        </fieldset>
        <Field label={t("reason")} required>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

// ---------- organiser payment (from the event: shows the settlement first) ----------
export type PaymentRow = { id: string; organiserId: string; organiserName?: string; eventId: string | null; eventName: string | null; eventCode?: string | null; amount: number; currency: string; paymentDate: string; bankReference: string | null; method: string; status: string; notes: string | null; voidReason?: string | null; createdByName?: string | null; createdAt?: string };
const METHODS = ["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"];

export function PayOrganiserDialog({ event, f, bookingFeeBps, mode, onClose, onSaved }: { event: { id: string; name: string; organiserId: string; organiserName: string | null }; f: Fig; bookingFeeBps: number | null; mode: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.fin");
  const tp = useTranslations("accounting.payments");
  const c = useTranslations("common");
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ amount: f.remaining > 0 ? toDecimalString(f.remaining, f.currency) : "", paymentDate: today, method: "BANK_TRANSFER", bankReference: "", notes: "", status: "PAID" });
  const [errs, setErrs] = useState<FieldErrors>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, x: string) => setV((o) => ({ ...o, [k]: x }));
  let amount: number | null = null; try { amount = v.amount ? parseMajor(v.amount, f.currency) : null; } catch { amount = null; }
  const after = amount === null ? null : f.remaining - amount;
  const submit = async () => {
    if (amount === null) { setErrs({ amount: t("pay.invalidAmount") }); return; }
    setBusy(true); setErr(null); setErrs({});
    try {
      await api("/api/accounting/organiser-payments", { json: { mode, organiserId: event.organiserId, eventId: event.id, amount, currency: f.currency, paymentDate: v.paymentDate, bankReference: v.bankReference || null, method: v.method, notes: v.notes || null, status: v.status } });
      toast("ok", tp("recorded")); onSaved(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const S = (label: string, val: React.ReactNode, strong?: boolean) => <div className={cn("flex items-baseline justify-between gap-3 py-1.5", strong && "border-t border-line pt-2 font-semibold")}><dt className={strong ? "" : "text-muted"}>{label}</dt><dd className="tabular-nums">{val}</dd></div>;
  return (
    <Modal open onClose={onClose} size="lg" title={t("pay.title")} description={t("pay.desc", { organiser: event.organiserName ?? "" })}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={amount === null || !v.paymentDate} onClick={submit}>{t("pay.submit")}</Button></>}>
      <div className="grid gap-5 md:grid-cols-[1fr_1.1fr]">
        <section aria-label={t("pay.summary")} className="rounded-xl border border-line bg-surface-2/50 p-4 text-sm">
          <p className="mb-2 font-semibold">{event.name} <span className="text-xs font-normal uppercase text-muted">{f.currency}</span></p>
          <dl>
            {S(t("k.grossSales"), <Money v={f.grossSales} c={f.currency} />)}
            {S(t("k.bookingFeePct"), pct(bookingFeeBps))}
            {S(t("k.bookingFees"), <>−<Money v={f.bookingFees} c={f.currency} /></>)}
            {S(t("k.refunds"), <>−<Money v={f.refunds + f.chargebacks} c={f.currency} /></>)}
            {f.feesRecharged !== 0 && S(t("k.feesRecharged"), <>−<Money v={f.feesRecharged} c={f.currency} /></>)}
            {S(t("k.deductions"), <>−<Money v={f.deductions} c={f.currency} /></>)}
            {S(t("k.organiserDue"), <Money v={f.organiserDue} c={f.currency} />, true)}
            {S(t("k.organiserPaid"), <Money v={f.organiserPaid} c={f.currency} />)}
            {S(t("k.remaining"), <Money v={f.remaining} c={f.currency} />, true)}
          </dl>
          <div className="mt-3"><SettlementBadge s={f.settlement} /></div>
        </section>
        <div className="grid content-start gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label={`${tp("amount")} (${f.currency.toUpperCase()})`} required error={errs.amount}>{(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} className="text-lg font-semibold" />}</Field>
            {after !== null && <p className={cn("mt-1 text-xs", after < 0 ? "text-fin-neg" : "text-muted")}>{after < 0 ? t("pay.overpay", { v: formatMoney(-after, f.currency) }) : t("pay.after", { v: formatMoney(after, f.currency) })}</p>}</div>
          <Field label={tp("date")} required error={errs.paymentDate}>{(p) => <Input {...p} type="date" value={v.paymentDate} onChange={(e) => set("paymentDate", e.target.value)} />}</Field>
          <Field label={tp("method")}>{(p) => <Select {...p} value={v.method} onChange={(e) => set("method", e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{tp(`m.${m}`)}</option>)}</Select>}</Field>
          <Field label={tp("reference")}>{(p) => <Input {...p} value={v.bankReference} onChange={(e) => set("bankReference", e.target.value)} placeholder="INV-1021" />}</Field>
          <Field label={tp("status")}>{(p) => <Select {...p} value={v.status} onChange={(e) => set("status", e.target.value)}><option value="PAID">{tp("st.PAID")}</option><option value="PENDING">{tp("st.PENDING")}</option></Select>}</Field>
          <div className="sm:col-span-2"><Field label={tp("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field></div>
          <p className="text-xs text-muted sm:col-span-2">{tp("modeNote", { mode: mode.toUpperCase() })}</p>
          {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
        </div>
      </div>
    </Modal>
  );
}

export function PaymentEditDialog({ p, onClose, onSaved }: { p: PaymentRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.fin");
  const tp = useTranslations("accounting.payments");
  const c = useTranslations("common");
  const toast = useToast();
  const [v, setV] = useState({ amount: toDecimalString(p.amount, p.currency), paymentDate: p.paymentDate, method: p.method, bankReference: p.bankReference ?? "", notes: p.notes ?? "", reason: "" });
  const [errs, setErrs] = useState<FieldErrors>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, x: string) => setV((o) => ({ ...o, [k]: x }));
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try {
      let amount: number; try { amount = parseMajor(v.amount, p.currency); } catch (e) { setErrs({ amount: errMsg(e) }); return; }
      await api(`/api/accounting/organiser-payments/${p.id}`, { method: "PATCH", json: { amount, paymentDate: v.paymentDate, method: v.method, bankReference: v.bankReference || null, notes: v.notes || null, reason: v.reason } });
      toast("ok", t("payEdit.saved")); onSaved(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("payEdit.title")} description={t("payEdit.desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={v.reason.trim().length < 3} onClick={submit}>{c("save")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${tp("amount")} (${p.currency.toUpperCase()})`} required error={errs.amount}>{(x) => <Input {...x} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} />}</Field>
        <Field label={tp("date")} required error={errs.paymentDate}>{(x) => <Input {...x} type="date" value={v.paymentDate} onChange={(e) => set("paymentDate", e.target.value)} />}</Field>
        <Field label={tp("method")}>{(x) => <Select {...x} value={v.method} onChange={(e) => set("method", e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{tp(`m.${m}`)}</option>)}</Select>}</Field>
        <Field label={tp("reference")}>{(x) => <Input {...x} value={v.bankReference} onChange={(e) => set("bankReference", e.target.value)} />}</Field>
        <div className="sm:col-span-2"><Field label={tp("notes")}>{(x) => <Textarea {...x} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field></div>
        <div className="sm:col-span-2"><Field label={t("changeReason")} required error={errs.reason}>{(x) => <Input {...x} value={v.reason} onChange={(e) => set("reason", e.target.value)} />}</Field></div>
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}

type PaymentDetail = { payment: PaymentRow & { revision: number; createdByName: string | null; updatedByName: string | null; voidedByName: string | null; voidedAt: string | null; updatedAt: string; createdAt: string }; entries: Array<{ id: string; seq: number; entryDate: string; entryType: string; description: string; status: string; reason: string | null }>; history: Array<{ type: string; at: string; userName: string | null; metadata: { reason?: string | null; old?: Record<string, unknown> | null; new?: Record<string, unknown> | null } }> };

export function PaymentViewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("accounting.fin");
  const tp = useTranslations("accounting.payments");
  const locale = useLocale();
  const { data } = useApi<PaymentDetail>(`/api/accounting/organiser-payments/${id}`);
  const p = data?.payment;
  return (
    <Modal open onClose={onClose} size="lg" title={t("payView.title")}>
      {!p ? <p className="text-sm text-muted">…</p> : <div className="space-y-5 text-sm">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {([[tp("amount"), <Money key="a" v={p.amount} c={p.currency} strong />], [tp("status"), p.status === "VOIDED" ? `${tp("st.VOIDED")} — ${p.voidReason ?? ""}` : tp(`st.${p.status}`)], [tp("organiser"), p.organiserName], [tp("event"), p.eventName ?? tp("noEvent")],
            [tp("date"), p.paymentDate], [tp("method"), tp(`m.${p.method}`)], [tp("reference"), p.bankReference ?? "—"], [t("payView.recordedBy"), `${p.createdByName ?? "—"} · ${fmtDate(p.createdAt, locale)}`],
            ...(p.updatedByName ? [[t("payView.editedBy"), `${p.updatedByName} · ${fmtDate(p.updatedAt, locale)} (r${p.revision})`]] : []), [tp("notes"), p.notes ?? "—"]] as Array<[string, React.ReactNode]>).map(([k, val]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd>{val}</dd></div>)}
        </dl>
        <section><h3 className="mb-2 font-semibold">{t("payView.ledger")}</h3><ul className="divide-y divide-line rounded-xl border border-line">{data.entries.map((e) => <li key={e.id} className="flex flex-wrap justify-between gap-2 px-3 py-2"><span>#{e.seq} · {e.entryDate} · {e.description}{e.reason && <span className="block text-xs text-muted">{e.reason}</span>}</span><span className="text-xs uppercase text-muted">{e.entryType} · {e.status}</span></li>)}</ul></section>
        <section><h3 className="mb-2 font-semibold">{t("payView.history")}</h3><AuditList items={data.history.map((h, i) => ({ id: String(i), ...h }))} /></section>
      </div>}
    </Modal>
  );
}

// ---------- audit list ----------
export type AuditItem = { id: string; type: string; at: string; userName: string | null; metadata: { reason?: string | null; old?: unknown; new?: unknown; [k: string]: unknown } };
const show = (v: unknown): string => v == null ? "—" : typeof v === "object" ? Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && typeof x !== "object").map(([k, x]) => `${k}: ${String(x)}`).join(", ") : String(v);
export function AuditList({ items }: { items: AuditItem[] }) {
  const t = useTranslations("accounting.fin");
  const locale = useLocale();
  if (!items.length) return <p className="text-sm text-muted">{t("audit.empty")}</p>;
  return (
    <ol className="space-y-3">{items.map((a) => (
      <li key={a.id} className="rounded-xl border border-line p-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium">{t.has(`audit.t.${a.type}` as never) ? t(`audit.t.${a.type}` as never) : a.type}</span><span className="text-xs text-muted">{fmtDate(a.at, locale)} · {a.userName ?? t("audit.system")}</span></div>
        {(a.metadata.old != null || a.metadata.new != null) && <dl className="mt-1.5 grid gap-1 text-xs sm:grid-cols-2">{a.metadata.old != null && <div><dt className="inline text-muted">{t("audit.from")}: </dt><dd className="inline break-words">{show(a.metadata.old)}</dd></div>}{a.metadata.new != null && <div><dt className="inline text-muted">{t("audit.to")}: </dt><dd className="inline break-words">{show(a.metadata.new)}</dd></div>}</dl>}
        {a.metadata.reason && <p className="mt-1 text-xs"><span className="text-muted">{t("audit.reason")}: </span>{a.metadata.reason}</p>}
      </li>
    ))}</ol>
  );
}

// ---------- expenses ----------
export const EXPENSE_CATEGORIES = ["VENUE", "ARTIST", "MARKETING", "SECURITY", "PRODUCTION", "STAFF", "TRANSPORT", "ACCOMMODATION", "OTHER"] as const;
export type ExpenseRow = { id: string; name: string; category: string; amount: number; currency: string; expenseDate: string; description: string | null; borneBy: string; status: string; hasReceipt: boolean; receiptName: string | null; voidReason: string | null; createdByName: string | null; revision: number };

export function ExpenseDialog({ eventId, currency, mode, hasOrganiser, expense, onClose, onSaved }: { eventId: string; currency: string; mode: string; hasOrganiser: boolean; expense?: ExpenseRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.fin.exp");
  const tf = useTranslations("accounting.fin");
  const c = useTranslations("common");
  const toast = useToast();
  const [v, setV] = useState({ name: expense?.name ?? "", category: expense?.category ?? "VENUE", amount: expense ? toDecimalString(expense.amount, currency) : "", expenseDate: expense?.expenseDate ?? new Date().toISOString().slice(0, 10), description: expense?.description ?? "", borneBy: expense?.borneBy ?? "BILIT", reason: "" });
  const [file, setFile] = useState<File | null>(null);
  const [errs, setErrs] = useState<FieldErrors>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, x: string) => setV((o) => ({ ...o, [k]: x }));
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try {
      let amount: number; try { amount = parseMajor(v.amount, currency); } catch (e) { setErrs({ amount: errMsg(e) }); return; }
      const base = { name: v.name, category: v.category, amount, expenseDate: v.expenseDate, description: v.description || null, borneBy: v.borneBy };
      const row = expense ? await api<{ id: string }>(`/api/accounting/expenses/${expense.id}`, { method: "PATCH", json: { ...base, reason: v.reason } })
        : await api<{ id: string }>("/api/accounting/expenses", { json: { ...base, mode, eventId, currency } });
      if (file) {
        const form = new FormData(); form.append("file", file);
        try { await api(`/api/accounting/expenses/${row.id}/receipt`, { form }); } catch (e) { toast("error", `${t("receiptFailed")}: ${errMsg(e)}`); }
      }
      toast("ok", expense ? t("updated") : t("added")); onSaved(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={expense ? t("edit") : t("add")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name || !v.amount || (!!expense && v.reason.trim().length < 3)} onClick={submit}>{c("save")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("name")} required error={errs.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={t("namePh")} />}</Field>
        <Field label={t("category")} required>{(p) => <Select {...p} value={v.category} onChange={(e) => set("category", e.target.value)}>{EXPENSE_CATEGORIES.map((k) => <option key={k} value={k}>{t(`cat.${k}`)}</option>)}</Select>}</Field>
        <Field label={`${t("amount")} (${currency.toUpperCase()})`} required error={errs.amount}>{(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} />}</Field>
        <Field label={t("date")} required error={errs.expenseDate}>{(p) => <Input {...p} type="date" value={v.expenseDate} onChange={(e) => set("expenseDate", e.target.value)} />}</Field>
        <div className="sm:col-span-2"><Field label={t("borneBy")} hint={t("borneByHint")} error={errs.borneBy}>{(p) => <Select {...p} value={v.borneBy} onChange={(e) => set("borneBy", e.target.value)}><option value="BILIT">{t("by.BILIT")}</option><option value="ORGANISER" disabled={!hasOrganiser}>{t("by.ORGANISER")}</option></Select>}</Field></div>
        <div className="sm:col-span-2"><Field label={t("description")}>{(p) => <Textarea {...p} value={v.description} onChange={(e) => set("description", e.target.value)} className="min-h-16" />}</Field></div>
        <div className="sm:col-span-2"><Field label={expense?.hasReceipt ? t("replaceReceipt") : t("receipt")} hint={t("receiptHint")}>{(p) => <Input {...p} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-1.5" />}</Field>
          {expense?.hasReceipt && <p className="mt-1 flex items-center gap-1 text-xs text-muted"><Paperclip className="size-3.5" aria-hidden />{expense.receiptName}</p>}</div>
        {expense && <div className="sm:col-span-2"><Field label={tf("changeReason")} required error={errs.reason}>{(p) => <Input {...p} value={v.reason} onChange={(e) => set("reason", e.target.value)} />}</Field></div>}
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}
