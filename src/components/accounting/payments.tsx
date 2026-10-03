"use client";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, CreditCard, Download, FileText, Landmark, Receipt, RefreshCw, ShieldAlert, Undo2, Wallet } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { formatMoney, parseMajor, toDecimalString } from "@/lib/money";

// ---------- live Stripe balance ----------
type Bal = { available: Array<{ currency: string; amount: number }>; pending: Array<{ currency: string; amount: number }> };
/** Available + pending balance per currency, straight from Stripe. */
export function StripeBalance() {
  const t = useTranslations("accounting.pay.balance");
  const { q } = useMode();
  const { data, error, loading, reload } = useApi<Bal>(q("/api/accounting/stripe/balance"));
  const curs = [...new Set([...(data?.available ?? []), ...(data?.pending ?? [])].map((x) => x.currency))].sort();
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Wallet className="size-4 text-fin-bal" aria-hidden />{t("title")}</h2>
        <Button size="sm" variant="ghost" onClick={() => void reload()} aria-label={t("refresh")}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />{t("live")}</Button>
      </div>
      {error ? <p className="px-5 py-4 text-sm text-muted">{error.message}</p> : !data ? <div className="p-4"><Skeleton className="h-14" /></div> : (
        <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">{curs.map((c) => {
          const av = data.available.find((x) => x.currency === c)?.amount ?? 0, pe = data.pending.find((x) => x.currency === c)?.amount ?? 0;
          return <div key={c} className="bg-surface p-4"><p className="text-xs font-semibold uppercase text-muted">{c}</p>
            <p className="mt-1 text-2xl font-semibold text-fin-bal"><Money v={av} c={c} /></p><p className="text-xs text-muted">{t("available")}</p>
            <p className="mt-2 text-sm"><Money v={pe} c={c} /> <span className="text-xs text-muted">{t("pending")}</span></p></div>;
        })}</div>)}
    </Card>
  );
}

// ---------- Stripe payouts ----------
type Payout = { id: string; payoutId: string; amount: number; currency: string; status: string; arrivalDate: string | null; stripeCreatedAt: string; automatic: boolean; includedCount: number | null; reconciliationStatus: string; failureMessage: string | null };
const PO_TONE: Record<string, string> = { paid: "text-fin-pos", in_transit: "text-fin-info", pending: "text-fin-info", failed: "text-fin-neg", canceled: "text-muted" };
/** Stripe payouts to the bank: totals per currency and the latest payouts. */
export function StripePayouts() {
  const t = useTranslations("accounting.pay.payouts");
  const locale = useLocale();
  const { q } = useMode();
  const { data } = useApi<{ items: Payout[]; total: number }>(q("/api/accounting/stripe/payouts?pageSize=200"));
  if (!data) return <Card className="mb-6 p-4"><Skeleton className="h-24" /></Card>;
  const by = new Map<string, { paid: number; transit: number; failed: number; n: number }>();
  for (const p of data.items) { const x = by.get(p.currency) ?? { paid: 0, transit: 0, failed: 0, n: 0 }; if (p.status === "paid") x.paid += p.amount; else if (p.status === "in_transit" || p.status === "pending") x.transit += p.amount; else if (p.status === "failed") x.failed += p.amount; x.n++; by.set(p.currency, x); }
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Landmark className="size-4 text-fin-info" aria-hidden />{t("title", { n: data.total })}</h2>
        <a href="/accounting/stripe/payouts" className="text-sm underline underline-offset-4">{t("all")}</a>
      </div>
      {!data.items.length ? <p className="px-5 py-4 text-sm text-muted">{t("none")}</p> : <>
        <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">{[...by].sort().map(([c, x]) => (
          <div key={c} className="bg-surface p-4 text-sm"><p className="text-xs font-semibold uppercase text-muted">{c} · {t("count", { n: x.n })}</p>
            <p className="mt-1 text-xl font-semibold text-fin-pos"><Money v={x.paid} c={c} /></p><p className="text-xs text-muted">{t("paidToBank")}</p>
            {x.transit > 0 && <p className="mt-1"><Money v={x.transit} c={c} className="text-fin-info" /> <span className="text-xs text-muted">{t("inTransit")}</span></p>}
            {x.failed > 0 && <p className="mt-1"><Money v={x.failed} c={c} className="text-fin-neg" /> <span className="text-xs text-muted">{t("failed")}</span></p>}</div>))}</div>
        <TableWrap><Table className="text-[13px]"><thead><tr><Th>{t("created")}</Th><Th>{t("arrival")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th className="text-end">{t("transactions")}</Th><Th>{t("payout")}</Th></tr></thead>
          <tbody>{data.items.slice(0, 10).map((p) => <Tr key={p.id}><Td className="whitespace-nowrap">{fmtDate(p.stripeCreatedAt, locale, { dateStyle: "medium" })}</Td><Td className="whitespace-nowrap">{p.arrivalDate ? fmtDate(p.arrivalDate, locale, { dateStyle: "medium" }) : "—"}</Td>
            <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><span className={cn("font-medium", PO_TONE[p.status])}>{p.status.replace(/_/g, " ")}</span>{p.failureMessage && <span className="block text-xs text-fin-neg">{p.failureMessage}</span>}</Td>
            <Td className="text-end tabular-nums">{p.includedCount ?? "—"}</Td><Td><code className="text-xs text-muted">{p.payoutId}</code></Td></Tr>)}</tbody></Table></TableWrap>
      </>}
    </Card>
  );
}

// ---------- payment status ----------
export type Charge = {
  chargeId: string; paymentIntentId: string | null; amount: number; amountCaptured: number; amountRefunded: number; currency: string; status: string; paid: boolean; refunded: boolean; disputed: boolean;
  description: string | null; customerName: string | null; customerEmail: string | null; failureCode: string | null; failureMessage: string | null; stripeCreatedAt: string; receiptUrl: string | null;
  outcome: { networkStatus: string | null; type: string | null; reason: string | null; riskLevel: string | null; riskScore: number | null; sellerMessage: string | null } | null;
  paymentMethod: { type: string; brand: string | null; last4: string | null; country: string | null; funding: string | null; wallet: string | null; expMonth: number | null; expYear: number | null; threeDSecure: string | null } | null;
  billingAddress: { line1?: string | null; city?: string | null; postalCode?: string | null; country?: string | null } | null;
};
export function chargeState(c: Pick<Charge, "status" | "refunded" | "amountRefunded" | "disputed">) {
  if (c.disputed) return "DISPUTED";
  if (c.status === "failed") return "FAILED";
  if (c.status === "pending") return "PENDING";
  if (c.refunded) return "REFUNDED";
  if (c.amountRefunded > 0) return "PARTIALLY_REFUNDED";
  return "SUCCEEDED";
}
const PILL = { SUCCEEDED: ["border-fin-pos/40 bg-fin-pos/12 text-fin-pos", CheckCircle2], FAILED: ["border-fin-neg/40 bg-fin-neg/12 text-fin-neg", Ban], PENDING: ["border-line-strong bg-surface-2 text-muted", CircleDashed], REFUNDED: ["border-fin-warn/40 bg-fin-warn/12 text-fin-warn", Undo2], PARTIALLY_REFUNDED: ["border-fin-warn/40 bg-fin-warn/12 text-fin-warn", Undo2], DISPUTED: ["border-fin-neg/40 bg-fin-neg/12 text-fin-neg", ShieldAlert] } as const;
export function ChargePill({ c }: { c: Pick<Charge, "status" | "refunded" | "amountRefunded" | "disputed"> }) {
  const t = useTranslations("accounting.pay.state");
  const s = chargeState(c);
  const [cls, Icon] = PILL[s];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", cls)}><Icon className="size-3.5" aria-hidden />{t(s)}</span>;
}
export const cardLabel = (pm: Charge["paymentMethod"]) => !pm ? "—" : pm.brand ? `${pm.wallet ? `${pm.wallet.replace(/_/g, " ")} · ` : ""}${pm.brand.toUpperCase()} •••• ${pm.last4 ?? ""}` : pm.type;
const RISK = { normal: "text-fin-pos", elevated: "text-fin-warn", highest: "text-fin-neg" } as Record<string, string>;
export function RiskLabel({ o }: { o: Charge["outcome"] }) {
  const t = useTranslations("accounting.pay");
  if (!o?.riskLevel) return <span className="text-muted">—</span>;
  return <span className={cn("font-medium", RISK[o.riskLevel] ?? "")}>{t.has(`risk.${o.riskLevel}` as never) ? t(`risk.${o.riskLevel}` as never) : o.riskLevel}{o.riskScore != null ? ` (${o.riskScore})` : ""}</span>;
}

type Refund = { id: string; refundId: string; amount: number; currency: string; status: string | null; reason: string | null; failureReason: string | null; note: string | null; keepBookingFee: boolean; stripeCreatedAt: string };
type Dispute = { id: string; disputeId: string; amount: number; currency: string; reason: string | null; status: string; stripeCreatedAt: string };

/** Everything Stripe knows about the payment: status, decline / risk outcome, card, refunds and disputes. */
export function PaymentInfo({ charge, refunds, disputes, btId, onChanged }: { charge: Charge | null; refunds: Refund[]; disputes: Dispute[]; btId: string; onChanged: () => void }) {
  const t = useTranslations("accounting.pay");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  if (!charge) return null;
  const c = charge;
  const refresh = async () => { setBusy(true); try { await api(`/api/accounting/transactions/${btId}/refresh`, { json: {} }); toast("ok", t("refreshed")); onChanged(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  const issues = [
    c.status === "failed" && { tone: "warn" as const, title: t("issue.failed"), body: [c.failureMessage, c.failureCode && `(${c.failureCode})`, c.outcome?.sellerMessage].filter(Boolean).join(" ") },
    c.disputed && { tone: "warn" as const, title: t("issue.disputed"), body: t("issue.disputedBody") },
    (c.outcome?.riskLevel === "elevated" || c.outcome?.riskLevel === "highest") && { tone: "warn" as const, title: t("issue.risk"), body: c.outcome?.sellerMessage ?? "" },
    ...refunds.filter((r) => r.status && ["failed", "canceled", "requires_action"].includes(r.status)).map((r) => ({ tone: "warn" as const, title: t("issue.refund", { status: r.status! }), body: r.failureReason ?? "" })),
  ].filter(Boolean) as Array<{ tone: "warn"; title: string; body: string }>;
  const DL = (items: Array<[string, React.ReactNode]>) => <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">{items.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="break-words">{v}</dd></div>)}</dl>;
  return (
    <Card>
      <CardHeader title={t("title")} description={t("desc")} action={<div className="flex items-center gap-2"><ChargePill c={c} />{can("accounting.manage") && <Button size="sm" variant="ghost" loading={busy} onClick={refresh}><RefreshCw className="size-3.5" aria-hidden />{t("refresh")}</Button>}</div>} />
      <div className="space-y-5 p-5">
        {issues.length > 0 && <div className="space-y-2">{issues.map((i, n) => <Callout key={n} tone="warn" icon={<AlertTriangle className="size-4" aria-hidden />} title={i.title}>{i.body}</Callout>)}</div>}
        {DL([
          [t("amount"), <Money key="a" v={c.amount} c={c.currency} strong />], [t("refunded"), c.amountRefunded ? <Money key="r" v={c.amountRefunded} c={c.currency} /> : null],
          [t("customer"), [c.customerName, c.customerEmail].filter(Boolean).join(" · ")], [t("card"), <span key="c" className="inline-flex items-center gap-1.5"><CreditCard className="size-3.5 text-muted" aria-hidden />{cardLabel(c.paymentMethod)}{c.paymentMethod?.country ? ` · ${c.paymentMethod.country}` : ""}{c.paymentMethod?.funding ? ` · ${c.paymentMethod.funding}` : ""}</span>],
          [t("threeDS"), c.paymentMethod?.threeDSecure], [t("network"), c.outcome?.networkStatus?.replace(/_/g, " ")], [t("riskLevel"), <RiskLabel key="k" o={c.outcome} />], [t("sellerMessage"), c.outcome?.sellerMessage],
          [t("failure"), c.failureMessage ? `${c.failureMessage}${c.failureCode ? ` (${c.failureCode})` : ""}` : null],
          [t("billing"), c.billingAddress ? [c.billingAddress.line1, [c.billingAddress.postalCode, c.billingAddress.city].filter(Boolean).join(" "), c.billingAddress.country].filter(Boolean).join(", ") : null],
          [t("charge"), <code key="ch" className="text-xs">{c.chargeId}</code>], [t("intent"), c.paymentIntentId ? <code key="pi" className="text-xs">{c.paymentIntentId}</code> : null],
          [t("receipt"), c.receiptUrl ? <a key="rc" href={c.receiptUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4"><Receipt className="size-3.5" aria-hidden />{t("openReceipt")}</a> : null],
        ])}
        {refunds.length > 0 && <div><h3 className="mb-2 text-sm font-semibold">{t("refunds")}</h3><TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th>{t("reason")}</Th><Th>{t("note")}</Th></tr></thead>
          <tbody>{refunds.map((r) => <Tr key={r.id}><Td className="whitespace-nowrap">{fmtDate(r.stripeCreatedAt, locale)}</Td><Td className="text-end"><Money v={r.amount} c={r.currency} strong /></Td>
            <Td><span className={cn("font-medium", r.status === "succeeded" ? "text-fin-pos" : r.status === "pending" ? "text-muted" : "text-fin-neg")}>{r.status ?? "—"}</span>{r.failureReason && <span className="block text-xs text-fin-neg">{r.failureReason}</span>}</Td>
            <Td className="text-sm">{r.reason?.replace(/_/g, " ") ?? "—"}{r.keepBookingFee && <span className="block text-xs text-muted">{t("keptFee")}</span>}</Td><Td className="text-sm text-muted">{r.note ?? ""}</Td></Tr>)}</tbody></Table></TableWrap></div>}
        {disputes.length > 0 && <div><h3 className="mb-2 text-sm font-semibold">{t("disputes")}</h3><ul className="space-y-1 text-sm">{disputes.map((d) => <li key={d.id} className="flex flex-wrap gap-x-3"><ShieldAlert className="size-4 text-fin-neg" aria-hidden /><Money v={d.amount} c={d.currency} strong /><span>{d.status.replace(/_/g, " ")}</span><span className="text-muted">{d.reason?.replace(/_/g, " ")}</span><span className="text-muted">{fmtDate(d.stripeCreatedAt, locale)}</span></li>)}</ul></div>}
      </div>
    </Card>
  );
}

// ---------- refund ----------
type RefundKind = "full" | "ticket" | "custom";
function RefundOption({ k, kind, setKind, label, sub, v, currency }: { k: RefundKind; kind: RefundKind; setKind: (k: RefundKind) => void; label: string; sub: string; v?: number; currency: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
      <input type="radio" name="refund-kind" className="mt-1" checked={kind === k} onChange={() => setKind(k)} />
      <span className="flex-1"><span className="flex justify-between gap-2 font-medium"><span>{label}</span>{v !== undefined && <span className="tabular-nums">{formatMoney(v, currency)}</span>}</span><span className="block text-xs text-muted">{sub}</span></span>
    </label>
  );
}

export function RefundDialog({ btId, charge, bookingFee, onClose, onDone }: { btId: string; charge: Charge; bookingFee: number; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("accounting.pay.refund");
  const c = useTranslations("common");
  const toast = useToast();
  const requestId = useMemo(() => crypto.randomUUID(), []);
  const refundable = Math.max(0, (charge.amountCaptured || charge.amount) - charge.amountRefunded);
  const ticketOnly = Math.max(0, Math.min(refundable, charge.amount - bookingFee - charge.amountRefunded));
  const [kind, setKind] = useState<RefundKind>(bookingFee > 0 && ticketOnly > 0 ? "ticket" : "full");
  const [custom, setCustom] = useState(""); const [keep, setKeep] = useState(false);
  const [reason, setReason] = useState("requested_by_customer"); const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false);
  let amount: number | null = kind === "full" ? refundable : kind === "ticket" ? ticketOnly : null;
  if (kind === "custom") { try { amount = custom ? parseMajor(custom, charge.currency) : null; } catch { amount = null; } }
  const keepFee = kind === "ticket" || (kind === "custom" && keep);
  const valid = amount !== null && amount > 0 && amount <= refundable;
  const m = (v: number) => formatMoney(v, charge.currency);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ status: string }>(`/api/accounting/transactions/${btId}/refund`, { json: { amount, reason, note: note || null, keepBookingFee: keepFee, requestId } }); toast("ok", t("done", { status: r.status })); onDone(); onClose(); }
    catch (e) { setErr(errMsg(e)); setConfirm(false); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("title")} description={t("desc", { customer: charge.customerName ?? charge.customerEmail ?? "" })}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button>{!confirm ? <Button variant="danger" disabled={!valid} onClick={() => setConfirm(true)}><Undo2 className="size-4" aria-hidden />{t("review")}</Button>
        : <Button variant="danger" loading={busy} onClick={submit}>{t("confirm", { amount: amount ? m(amount) : "" })}</Button>}</>}>
      <div className="space-y-4">
        <dl className="grid grid-cols-3 gap-2 rounded-xl bg-surface-2/60 p-3 text-sm"><div><dt className="text-xs text-muted">{t("paid")}</dt><dd className="font-semibold"><Money v={charge.amount} c={charge.currency} /></dd></div><div><dt className="text-xs text-muted">{t("alreadyRefunded")}</dt><dd className="font-semibold"><Money v={charge.amountRefunded} c={charge.currency} /></dd></div><div><dt className="text-xs text-muted">{t("refundable")}</dt><dd className="font-semibold text-fin-warn"><Money v={refundable} c={charge.currency} /></dd></div></dl>
        <div className="space-y-2">
          {bookingFee > 0 && ticketOnly > 0 && <RefundOption k="ticket" kind={kind} setKind={setKind} currency={charge.currency} label={t("ticketOnly")} sub={t("ticketOnlySub", { fee: m(bookingFee) })} v={ticketOnly} />}
          <RefundOption k="full" kind={kind} setKind={setKind} currency={charge.currency} label={t("full")} sub={t("fullSub")} v={refundable} />
          <RefundOption k="custom" kind={kind} setKind={setKind} currency={charge.currency} label={t("custom")} sub={t("customSub")} />
          {kind === "custom" && <div className="grid gap-3 ps-8 sm:grid-cols-2"><Field label={`${t("amount")} (${charge.currency.toUpperCase()})`} error={amount !== null && amount > refundable ? t("tooMuch") : null}>{(p) => <Input {...p} inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={toDecimalString(refundable, charge.currency)} />}</Field>
            <div className="flex items-end pb-2"><Checkbox label={t("keepFee")} checked={keep} onChange={(e) => setKeep(e.target.checked)} /></div></div>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("reason")}>{(p) => <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>{["requested_by_customer", "duplicate", "fraudulent"].map((r) => <option key={r} value={r}>{t(`reasons.${r}`)}</option>)}</Select>}</Field>
          <Field label={t("note")} hint={t("noteHint")}>{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
        {confirm && <Callout tone="warn" title={t("confirmTitle")}>{t("confirmBody", { amount: amount ? m(amount) : "" })}</Callout>}
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

// ---------- invoices & credit notes ----------
type Inv = { id: string; kind: string; number: string; vatInvoice: boolean; balanceTransactionRef: string; issueDate: string; currency: string; grossTotal: number; vatTotal: number; status: string; voidReason: string | null; customer: { name: string; company?: string | null } };
type Rel = { id: string; kind: string; amount: number; currency: string; stripeCreatedAt: string };

export function InvoicesCard({ saleBtId, related, charge }: { saleBtId: string; related: Rel[]; charge: Charge | null }) {
  const t = useTranslations("accounting.pay.inv");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { data, reload } = useApi<{ items: Inv[] }>(`/api/accounting/transactions/${saleBtId}/invoices`);
  const [issue, setIssue] = useState<{ btId: string; vat: boolean; credit: boolean } | null>(null);
  const [del, setDel] = useState<Inv | null>(null); const [reason, setReason] = useState("");
  const items = data?.items ?? [];
  const docsFor = (btId: string) => items.filter((i) => i.balanceTransactionRef === btId);
  const manage = can("accounting.manage");
  const rows = related.filter((r) => ["SALE", "REFUND", "DISPUTE"].includes(r.kind));
  return (
    <Card>
      <CardHeader title={t("title")} description={t("desc")} />
      <ul className="divide-y divide-line">{rows.map((r) => {
        const docs = docsFor(r.id), live = docs.find((d) => d.status === "ISSUED"), credit = r.kind !== "SALE";
        return <li key={r.id} className="space-y-2 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="flex items-center gap-2"><FileText className="size-4 text-muted" aria-hidden /><span className="font-medium">{credit ? t("refundOf", { date: fmtDate(r.stripeCreatedAt, locale, { dateStyle: "medium" }) }) : t("sale")}</span><Money v={Math.abs(r.amount)} c={r.currency} /></span>
            {manage && !live && <div className="flex flex-wrap gap-2">{credit ? <Button size="sm" onClick={() => setIssue({ btId: r.id, vat: false, credit: true })}>{t("issueCredit")}</Button>
              : <><Button size="sm" onClick={() => setIssue({ btId: r.id, vat: false, credit: false })}>{t("issueInvoice")}</Button><Button size="sm" variant="primary" onClick={() => setIssue({ btId: r.id, vat: true, credit: false })}><Landmark className="size-3.5" aria-hidden />{t("issueVat")}</Button></>}</div>}</div>
          {docs.map((d) => <div key={d.id} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm", d.status === "VOIDED" && "text-muted")}>
            <span><span className={cn("font-mono text-xs font-semibold", d.status === "VOIDED" && "line-through")}>{d.number}</span> · {t(`kind.${d.kind}${d.vatInvoice ? "_VAT" : ""}`)} · {d.customer.company ?? d.customer.name} · <Money v={d.grossTotal} c={d.currency} />{d.vatTotal ? <> ({t("vat")} <Money v={d.vatTotal} c={d.currency} />)</> : null}{d.status === "VOIDED" && <span className="ms-1 text-xs">— {t("voided")}: {d.voidReason}</span>}</span>
            <span className="flex gap-1"><a href={`/api/accounting/customer-invoices/${d.id}/pdf`} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 hover:bg-surface-2"><Download className="size-3.5" aria-hidden />PDF</a>
              {manage && d.status === "ISSUED" && <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) { setReason(""); setDel(d); } }}>{t("void")}</Button>}</span></div>)}
        </li>;
      })}</ul>
      {issue && <IssueInvoiceDialog btId={issue.btId} vat={issue.vat} credit={issue.credit} charge={charge} onClose={() => setIssue(null)} onDone={() => void reload()} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("voidTitle")} description={t("voidDesc")} confirmLabel={t("void")}
        onConfirm={async () => { try { await api(`/api/accounting/customer-invoices/${del!.id}/void`, { json: { reason } }); toast("ok", t("voidedToast")); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("reason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </Card>
  );
}

function IssueInvoiceDialog({ btId, vat, credit, charge, onClose, onDone }: { btId: string; vat: boolean; credit: boolean; charge: Charge | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("accounting.pay.inv");
  const c = useTranslations("common");
  const toast = useToast();
  const a = charge?.billingAddress;
  const [v, setV] = useState({ name: charge?.customerName ?? "", email: charge?.customerEmail ?? "", company: "", address: a ? [a.line1, [a.postalCode, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n") : "", vatNumber: "", country: a?.country ?? "" });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, x: string) => setV((o) => ({ ...o, [k]: x }));
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ number: string }>(`/api/accounting/transactions/${btId}/invoices`, { json: { vatInvoice: vat, customer: { name: v.name || "Customer", email: v.email || null, company: v.company || null, address: v.address || null, vatNumber: v.vatNumber || null, country: v.country || null } } }); toast("ok", t("issued", { number: r.number })); onDone(); onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={credit ? t("issueCredit") : vat ? t("issueVat") : t("issueInvoice")} description={vat ? t("vatDesc") : t("plainDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name || (vat && (!v.address || !(v.company || v.name)))} onClick={submit}>{t("issue")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("c.name")} required>{(p) => <Input {...p} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label={t("c.email")}>{(p) => <Input {...p} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
        {vat && <><Field label={t("c.company")}>{(p) => <Input {...p} value={v.company} onChange={(e) => set("company", e.target.value)} />}</Field>
          <Field label={t("c.vatNumber")} hint={t("c.vatNumberHint")}>{(p) => <Input {...p} value={v.vatNumber} onChange={(e) => set("vatNumber", e.target.value)} />}</Field></>}
        <div className="sm:col-span-2"><Field label={t("c.address")} required={vat}>{(p) => <Textarea {...p} value={v.address} onChange={(e) => set("address", e.target.value)} className="min-h-20" />}</Field></div>
        <Field label={t("c.country")}>{(p) => <Input {...p} value={v.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} className="uppercase" />}</Field>
        <p className="text-xs text-muted sm:col-span-2">{t("immutable")}</p>
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}
