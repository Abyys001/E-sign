"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Banknote, CheckCircle2, Download, Eye, FilePlus2, HandCoins, Paperclip, Pencil, Percent, PiggyBank, Plus, Receipt, Scale, Trash2, Wallet } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { AmountCard, Badge, Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { AgreementFields, agreementFrom, agreementPayload, emptyAgreement, EventDialog, type AgreementValue } from "@/components/accounting/forms";
import { AuditList, BookingFeeDialog, ExpenseDialog, moneyFlow, PayOrganiserDialog, PaymentEditDialog, PaymentViewDialog, pct, profitAndLoss, SettlementBadge, SettlementSummary, Statement, type AuditItem, type ExpenseRow, type Fig, type PaymentRow } from "@/components/accounting/finance";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { bpsToPercent, formatMoney } from "@/lib/money";

type Ag = { id: string; version: number; percentBps: number; percentBasis: string; fixedPerTicket: number; fixedEventFee: number; stripeFeesBorneBy: string; chargebacksBorneBy: string; refundsReverseCommission: boolean; notes: string | null; createdAt: string };
type Ev = { id: string; name: string; code: string; currency: string; status: string; startsOn: string | null; organiserId: string | null; organiserName: string | null; notes: string | null; currentAgreementId: string | null };
type FinData = { event: Ev; agreement: Ag | null; figures: Array<Fig & { bookingFeeBps: number | null }> };
type TabId = "overview" | "transactions" | "payments" | "expenses" | "refunds" | "pl" | "reports" | "audit";

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <EventFinance id={id} />; }

function EventFinance({ id }: { id: string }) {
  const t = useTranslations("accounting.fin");
  const te = useTranslations("accounting.events");
  const locale = useLocale();
  const { can } = useMe();
  const { mode, q } = useMode();
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "all" });
  const r = rangeFor(range.key, range);
  const { data, loading, error, reload } = useApi<FinData>(q(`/api/accounting/events/${id}/financials?x=1${rangeQuery(r)}`));
  const [cur, setCur] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const [edit, setEdit] = useState(false); const [fee, setFee] = useState(false); const [pay, setPay] = useState(false);
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-16" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div></div>;
  if (error || !data) return <EmptyState title={te("notFound")} description={error?.message} />;
  const e = data.event;
  const f = data.figures.find((x) => x.currency === cur) ?? data.figures.find((x) => x.currency === e.currency) ?? data.figures[0]!;
  const bps = data.agreement?.percentBps ?? null;
  const manage = can("accounting.manage");
  const tabs: Array<{ id: TabId; label: string }> = (["overview", "transactions", "payments", "expenses", "refunds", "pl", "reports", "audit"] as TabId[]).map((k) => ({ id: k, label: t(`tabs.${k}`) }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{e.name} <Badge s={e.status} /></span>}
        description={[e.startsOn ? fmtDate(`${e.startsOn}T12:00:00Z`, locale, { dateStyle: "long" }) : null, e.code].filter(Boolean).join(" · ")}
        actions={<>
          <LinkButton href="/accounting/events"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{te("back")}</LinkButton>
          {manage && <Button onClick={() => setEdit(true)}><Pencil className="size-4" aria-hidden />{te("edit")}</Button>}
          {manage && e.organiserId && <Button variant="primary" onClick={() => setPay(true)}><Banknote className="size-4" aria-hidden />{t("payOrganiser")}</Button>}
        </>} />

      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div className="flex items-center gap-2"><span className="text-sm text-muted">{t("financialStatus")}</span><SettlementBadge s={f.settlement} /></div>
        <div className="flex items-center gap-2"><span className="text-sm text-muted">{t("k.bookingFeePct")}</span><span className="rounded-lg bg-surface-2 px-2 py-0.5 text-base font-semibold tabular-nums">{pct(bps)}</span>{data.agreement && <span className="text-xs text-muted">{t(`fee.basisShort.${data.agreement.percentBasis}`)}</span>}
          {manage && <Button size="sm" variant="ghost" onClick={() => setFee(true)}><Percent className="size-3.5" aria-hidden />{t("changeFee")}</Button>}</div>
        <div className="text-sm"><span className="text-muted">{t("organiser")}: </span>{e.organiserId ? <Link href={`/accounting/organisers/${e.organiserId}`} className="font-medium underline-offset-4 hover:underline">{e.organiserName}</Link> : <span className="font-medium text-fin-warn">{te("noOrganiserWarn")}</span>}</div>
        <div className="text-sm"><span className="text-muted">{t("k.tickets")}: </span><span className="font-semibold tabular-nums">{f.tickets.toLocaleString(locale)}</span><span className="text-muted"> · {t("k.orders")}: </span><span className="tabular-nums">{f.orders.toLocaleString(locale)}</span></div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {data.figures.length > 1 && <Select aria-label={t("currency")} value={f.currency} onChange={(x) => setCur(x.target.value)} className="w-auto font-semibold uppercase">{data.figures.map((x) => <option key={x.currency} value={x.currency}>{x.currency.toUpperCase()}</option>)}</Select>}
          <RangePicker value={range} onChange={setRange} keys={["all", "month", "lastMonth", "year", "custom"]} />
        </div>
      </Card>
      {f.currency !== e.currency && <Callout tone="warn">{t("otherCurrency", { c: f.currency.toUpperCase(), e: e.currency.toUpperCase() })}</Callout>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AmountCard label={t("kpi.gross")} v={f.grossSales} c={f.currency} tone="pos" icon={Receipt} hint={<>{t("k.netSales")}: <Money v={f.netSales} c={f.currency} className="font-medium text-fg" /></>} />
        <AmountCard label={t("kpi.bookingFees")} v={f.bookingFees} c={f.currency} tone="pos" icon={Percent} hint={`${pct(bps)} · ${t(`fee.basisShort.${data.agreement?.percentBasis ?? "ADDED"}`)}`} />
        <AmountCard label={t("kpi.due")} v={f.organiserDue} c={f.currency} tone="info" icon={Scale} hint={t("kpi.dueHint")} />
        <AmountCard label={t("kpi.paid")} v={f.organiserPaid} c={f.currency} tone="bal" icon={Wallet} hint={f.pendingPayments ? <>{t("pendingNote")}: <Money v={f.pendingPayments} c={f.currency} /></> : undefined} />
        <AmountCard label={t("kpi.remaining")} v={f.remaining} c={f.currency} tone={f.remaining === 0 ? "pos" : "warn"} icon={HandCoins} hint={<SettlementBadge s={f.settlement} />} />
        <AmountCard label={t("kpi.profit")} v={f.bilitProfit} c={f.currency} tone="pos" icon={PiggyBank} hint={t("kpi.profitHint")} />
      </div>

      <div>
        <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("tabs.label")} />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-5">
          {tab === "overview" && <Overview e={e} f={f} agreement={data.agreement} reload={reload} />}
          {tab === "transactions" && <TxTab eventId={id} kinds={["SALE"]} />}
          {tab === "refunds" && <TxTab eventId={id} kinds={["REFUND", "DISPUTE", "DISPUTE_REVERSAL"]} />}
          {tab === "payments" && <PaymentsTab e={e} onPay={() => setPay(true)} onChanged={reload} />}
          {tab === "expenses" && <ExpensesTab e={e} onChanged={reload} />}
          {tab === "pl" && <PlTab f={f} e={e} />}
          {tab === "reports" && <ReportsTab e={e} />}
          {tab === "audit" && <AuditTab eventId={id} />}
        </div>
      </div>

      {edit && <EventDialog open={edit} onClose={() => setEdit(false)} onSaved={() => void reload()} eventId={id} initial={{ name: e.name, code: e.code, currency: e.currency, organiserId: e.organiserId ?? "", startsOn: e.startsOn ?? "", status: e.status, notes: e.notes ?? "" }} />}
      {fee && <BookingFeeDialog eventId={id} currentBps={bps} currentBasis={data.agreement?.percentBasis} onClose={() => setFee(false)} onSaved={() => void reload()} />}
      {pay && e.organiserId && <PayOrganiserDialog event={{ id, name: e.name, organiserId: e.organiserId, organiserName: e.organiserName }} f={f} bookingFeeBps={bps} mode={mode} onClose={() => setPay(false)} onSaved={() => void reload()} />}
    </div>
  );
}

// ---------- overview ----------
function Overview({ e, f, agreement, reload }: { e: Ev; f: Fig; agreement: Ag | null; reload: () => Promise<void> }) {
  const t = useTranslations("accounting.fin");
  const te = useTranslations("accounting.events");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const { mode, q } = useMode();
  const { data: ags, reload: reloadAgs } = useApi<{ agreements: Ag[] }>(q(`/api/accounting/events/${e.id}`));
  const [agOpen, setAgOpen] = useState(false);
  const [ag, setAg] = useState<AgreementValue>(emptyAgreement()); const [reason, setReason] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const saveAg = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/accounting/events/${e.id}/agreement`, { json: { ...agreementPayload(ag, e.currency), reason } }); toast("ok", te("agreementSaved")); setAgOpen(false); setReason(""); await Promise.all([reload(), reloadAgs()]); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const postFee = async () => { try { await api(`/api/accounting/events/${e.id}/event-fee`, { json: { mode, date: new Date().toISOString().slice(0, 10) } }); toast("ok", te("feePosted")); await reload(); } catch (x) { toast("error", errMsg(x)); } };
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card><CardHeader title={t("flow.title")} description={t("flow.desc")} /><div className="px-5 pb-4"><Statement lines={moneyFlow(f, t)} currency={f.currency} caption={t("flow.title")} /></div></Card>
        <div className="space-y-6">
          <Card><CardHeader title={t("settlement.title")} /><div className="p-5"><SettlementSummary f={f} /></div></Card>
          <Card><CardHeader title={t("separation.title")} description={t("separation.desc")} />
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-card bg-line text-sm">
              {([["customers", f.netSales, "text-fg"], ["bookingFee", f.bookingFees, "text-fin-pos"], ["organiser", f.organiserDue, "text-fin-info"], ["bilit", f.bilitProfit, f.bilitProfit < 0 ? "text-fin-neg" : "text-fin-pos"]] as const).map(([k, v, cls]) => (
                <div key={k} className="bg-surface p-4"><dt className="text-xs text-muted">{t(`separation.${k}`)}</dt><dd className={`mt-1 text-lg font-semibold tabular-nums ${cls}`}><Money v={v} c={f.currency} /></dd></div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
      <Card><CardHeader title={t("terms.title")} description={t("terms.desc")} action={can("accounting.manage") && <div className="flex flex-wrap gap-2">
          {agreement && agreement.fixedEventFee > 0 && <Button size="sm" onClick={postFee}>{te("postFee", { amount: formatMoney(agreement.fixedEventFee, e.currency, locale) })}</Button>}
          <Button size="sm" onClick={() => { setAg(agreement ? agreementFrom(agreement, e.currency) : emptyAgreement()); setAgOpen(true); }}><FilePlus2 className="size-4" aria-hidden />{te("newAgreement")}</Button></div>} />
        <TableWrap><Table><thead><tr><Th>{te("version")}</Th><Th>{t("k.bookingFeePct")}</Th><Th>{te("perTicket")}</Th><Th>{te("eventFee")}</Th><Th>{te("feesBy")}</Th><Th>{te("chargebacksBy")}</Th><Th>{te("created")}</Th></tr></thead>
          <tbody>{(ags?.agreements ?? []).map((a) => <Tr key={a.id} className={a.id === e.currentAgreementId ? "font-medium" : "text-muted"}><Td>v{a.version}{a.id === e.currentAgreementId && <span className="ms-2"><Badge s="ACTIVE" /></span>}{a.notes && <span className="block max-w-xs truncate text-xs font-normal text-muted" title={a.notes}>{a.notes}</span>}</Td><Td>{bpsToPercent(a.percentBps)} % <span className="text-xs text-muted">{t(`fee.basisShort.${a.percentBasis}`)}</span></Td><Td><Money v={a.fixedPerTicket} c={e.currency} /></Td><Td><Money v={a.fixedEventFee} c={e.currency} /></Td><Td>{te(`by.${a.stripeFeesBorneBy}`)}</Td><Td>{te(`by.${a.chargebacksBorneBy}`)}</Td><Td>{fmtDate(a.createdAt, locale)}</Td></Tr>)}</tbody></Table></TableWrap>
      </Card>
      <Modal open={agOpen} onClose={() => setAgOpen(false)} size="lg" title={te("newAgreement")} description={te("newAgreementDesc")}
        footer={<><Button onClick={() => setAgOpen(false)}>{te("cancel")}</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 3} onClick={saveAg}>{te("saveAgreement")}</Button></>}>
        <div className="space-y-4"><AgreementFields v={ag} onChange={setAg} currency={e.currency} /><Field label={te("changeReason")} required>{(p) => <Input {...p} value={reason} onChange={(x) => setReason(x.target.value)} />}</Field>{err && <Callout tone="warn">{err}</Callout>}</div>
      </Modal>
    </div>
  );
}

// ---------- transactions / refunds (traceable to Stripe + ledger) ----------
type Tx = { id: string; balanceTransactionId: string; kind: string; amount: number; fee: number; net: number; currency: string; description: string | null; stripeCreatedAt: string; customerName: string | null; ticketQuantity: number | null; commissionAmount: number | null; organiserAmount: number | null; reconciliationStatus: string };
function TxTab({ eventId, kinds }: { eventId: string; kinds: string[] }) {
  const t = useTranslations("accounting.fin.tx");
  const tk = useTranslations("accounting.kind");
  const locale = useLocale();
  const { q } = useMode();
  const [kind, setKind] = useState(kinds[0]!); const [page, setPage] = useState(1);
  const { data, loading } = useApi<{ items: Tx[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/transactions?eventId=${eventId}&kind=${kind}&page=${page}&pageSize=50`));
  return (
    <Card>
      <CardHeader title={t(kinds[0] === "SALE" ? "salesTitle" : "refundsTitle")} description={t("traceDesc")} action={kinds.length > 1 && <Select aria-label={t("kind")} value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} className="h-9 w-auto">{kinds.map((k) => <option key={k} value={k}>{tk(k)}</option>)}</Select>} />
      {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} /> : <>
        <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("order")}</Th>{kind === "SALE" && <Th className="text-end">{t("tickets")}</Th>}<Th className="text-end">{t("amount")}</Th><Th className="text-end">{t("bookingFee")}</Th><Th className="text-end">{t("stripeFee")}</Th><Th className="text-end">{t("organiser")}</Th><Th>{t("status")}</Th></tr></thead>
          <tbody>{data.items.map((x) => <Tr key={x.id}>
            <Td className="whitespace-nowrap">{fmtDate(x.stripeCreatedAt, locale, { dateStyle: "short", timeStyle: "short" })}</Td>
            <Td className="max-w-xs"><Link href={`/accounting/transactions/${x.id}`} className="block truncate font-medium underline-offset-4 hover:underline" title={x.description ?? ""}>{x.customerName ?? x.description ?? x.balanceTransactionId}</Link><code className="text-xs text-muted">{x.balanceTransactionId}</code></Td>
            {kind === "SALE" && <Td className="text-end tabular-nums">{x.ticketQuantity ?? 1}</Td>}
            <Td className="text-end"><Money v={x.amount} c={x.currency} strong /></Td><Td className="text-end"><Money v={x.commissionAmount ?? 0} c={x.currency} /></Td>
            <Td className="text-end text-muted"><Money v={x.fee} c={x.currency} /></Td><Td className="text-end"><Money v={x.organiserAmount ?? 0} c={x.currency} /></Td><Td><Badge s={x.reconciliationStatus} /></Td></Tr>)}</tbody></Table></TableWrap>
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
    </Card>
  );
}

// ---------- organiser payments ----------
function PaymentsTab({ e, onPay, onChanged }: { e: Ev; onPay: () => void; onChanged: () => Promise<void> }) {
  const t = useTranslations("accounting.fin");
  const tp = useTranslations("accounting.payments");
  const toast = useToast();
  const ensure = useElevation();
  const doExport = useExport();
  const { can } = useMe();
  const { q } = useMode();
  const { data, loading, reload } = useApi<{ items: PaymentRow[] }>(q(`/api/accounting/organiser-payments?eventId=${e.id}&pageSize=200`));
  const [view, setView] = useState<string | null>(null); const [edit, setEdit] = useState<PaymentRow | null>(null); const [del, setDel] = useState<PaymentRow | null>(null); const [reason, setReason] = useState("");
  const after = async () => { await Promise.all([reload(), onChanged()]); };
  const markPaid = async (p: PaymentRow) => { try { await api(`/api/accounting/organiser-payments/${p.id}`, { method: "PATCH", json: { status: "PAID" } }); toast("ok", tp("markedPaid")); await after(); } catch (x) { toast("error", errMsg(x)); } };
  const manage = can("accounting.manage");
  return (
    <Card>
      <CardHeader title={t("payments.title")} description={t("payments.desc")} action={<div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => doExport(ensure, q(`/api/accounting/organiser-payments?eventId=${e.id}`))}><Download className="size-4" aria-hidden />{t("export")}</Button>
        {manage && e.organiserId && <Button size="sm" variant="primary" onClick={onPay}><Banknote className="size-4" aria-hidden />{t("payOrganiser")}</Button>}</div>} />
      {loading && !data ? <div className="p-4"><Skeleton className="h-24" /></div> : !data?.items.length ? <EmptyState title={tp("empty")} description={tp("emptyDesc")} /> : (
        <TableWrap><Table><thead><tr><Th>{tp("date")}</Th><Th className="text-end">{tp("amount")}</Th><Th>{tp("method")}</Th><Th>{tp("reference")}</Th><Th>{tp("status")}</Th><Th><span className="sr-only">{tp("actions")}</span></Th></tr></thead>
          <tbody>{data.items.map((p) => <Tr key={p.id} className={p.status === "VOIDED" ? "text-muted line-through decoration-1" : ""}>
            <Td className="whitespace-nowrap">{p.paymentDate}{p.notes && <span className="block max-w-xs truncate text-xs text-muted no-underline" title={p.notes}>{p.notes}</span>}</Td>
            <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td>{tp(`m.${p.method}`)}</Td><Td><code className="text-xs">{p.bankReference ?? "—"}</code></Td>
            <Td><Badge s={p.status} />{p.voidReason && <span className="block text-xs">{p.voidReason}</span>}</Td>
            <Td className="text-end"><div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => setView(p.id)} aria-label={t("view")}><Eye className="size-3.5" aria-hidden /></Button>
              {manage && p.status === "PENDING" && <Button size="sm" onClick={() => markPaid(p)}><CheckCircle2 className="size-3.5" aria-hidden />{tp("markPaid")}</Button>}
              {manage && p.status !== "VOIDED" && <><Button size="sm" variant="ghost" onClick={() => setEdit(p)} aria-label={t("editItem")}><Pencil className="size-3.5" aria-hidden /></Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) { setReason(""); setDel(p); } }} aria-label={t("deleteItem")}><Trash2 className="size-3.5" aria-hidden /></Button></>}
            </div></Td></Tr>)}</tbody></Table></TableWrap>)}
      {view && <PaymentViewDialog id={view} onClose={() => setView(null)} />}
      {edit && <PaymentEditDialog p={edit} onClose={() => setEdit(null)} onSaved={() => void after()} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("payDelete.title")} description={t("payDelete.desc")} confirmLabel={t("deleteItem")}
        onConfirm={async () => { try { await api(`/api/accounting/organiser-payments/${del!.id}/void`, { json: { reason } }); toast("ok", tp("voided")); await after(); } catch (x) { toast("error", errMsg(x)); throw x; } }}>
        <Field label={tp("voidReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(x) => setReason(x.target.value)} />}</Field>
      </ConfirmDialog>
    </Card>
  );
}

// ---------- expenses ----------
function ExpensesTab({ e, onChanged }: { e: Ev; onChanged: () => Promise<void> }) {
  const t = useTranslations("accounting.fin.exp");
  const tf = useTranslations("accounting.fin");
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { mode, q } = useMode();
  const { data, loading, reload } = useApi<{ items: ExpenseRow[] }>(q(`/api/accounting/expenses?eventId=${e.id}`));
  const [open, setOpen] = useState<ExpenseRow | "new" | null>(null); const [del, setDel] = useState<ExpenseRow | null>(null); const [reason, setReason] = useState("");
  const after = async () => { await Promise.all([reload(), onChanged()]); };
  const active = (data?.items ?? []).filter((x) => x.status === "ACTIVE");
  const total = (by: string) => active.filter((x) => x.borneBy === by).reduce((s, x) => s + x.amount, 0);
  const manage = can("accounting.manage");
  return (
    <Card>
      <CardHeader title={t("title")} description={t("tabDesc")} action={manage && <Button size="sm" variant="primary" onClick={() => setOpen("new")}><Plus className="size-4" aria-hidden />{t("add")}</Button>} />
      {active.length > 0 && <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-line px-5 py-3 text-sm"><span><span className="text-muted">{t("totalBilit")}: </span><Money v={total("BILIT")} c={e.currency} strong /></span><span><span className="text-muted">{t("totalOrganiser")}: </span><Money v={total("ORGANISER")} c={e.currency} strong /></span></div>}
      {loading && !data ? <div className="p-4"><Skeleton className="h-24" /></div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : (
        <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("name")}</Th><Th>{t("category")}</Th><Th>{t("borneBy")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("receipt")}</Th><Th><span className="sr-only">{tf("actions")}</span></Th></tr></thead>
          <tbody>{data.items.map((x) => <Tr key={x.id} className={x.status === "VOIDED" ? "text-muted" : ""}>
            <Td className="whitespace-nowrap">{x.expenseDate}</Td>
            <Td><span className={x.status === "VOIDED" ? "line-through" : "font-medium"}>{x.name}</span>{x.description && <span className="block max-w-xs truncate text-xs text-muted" title={x.description}>{x.description}</span>}{x.status === "VOIDED" && <span className="block text-xs">{t("deleted")}: {x.voidReason}</span>}</Td>
            <Td>{t(`cat.${x.category}`)}</Td><Td className="text-sm">{t(`by.${x.borneBy}`)}</Td><Td className="text-end"><Money v={x.amount} c={x.currency} strong /></Td>
            <Td>{x.hasReceipt ? <a href={`/api/accounting/expenses/${x.id}/receipt`} className="inline-flex items-center gap-1 text-sm underline underline-offset-4"><Paperclip className="size-3.5" aria-hidden />{t("download")}</a> : <span className="text-muted">—</span>}</Td>
            <Td className="text-end">{manage && x.status === "ACTIVE" && <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => setOpen(x)} aria-label={tf("editItem")}><Pencil className="size-3.5" aria-hidden /></Button>
              <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) { setReason(""); setDel(x); } }} aria-label={tf("deleteItem")}><Trash2 className="size-3.5" aria-hidden /></Button></div>}</Td></Tr>)}</tbody></Table></TableWrap>)}
      {open && <ExpenseDialog eventId={e.id} currency={e.currency} mode={mode} hasOrganiser={!!e.organiserId} expense={open === "new" ? undefined : open} onClose={() => setOpen(null)} onSaved={() => void after()} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("deleteTitle")} description={t("deleteDesc")} confirmLabel={tf("deleteItem")}
        onConfirm={async () => { try { await api(`/api/accounting/expenses/${del!.id}/void`, { json: { reason } }); toast("ok", t("deletedToast")); await after(); } catch (x) { toast("error", errMsg(x)); throw x; } }}>
        <Field label={t("deleteReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(x) => setReason(x.target.value)} />}</Field>
      </ConfirmDialog>
    </Card>
  );
}

// ---------- P&L ----------
function PlTab({ f, e }: { f: Fig; e: Ev }) {
  const t = useTranslations("accounting.fin");
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card><CardHeader title={t("pl.title")} description={t("pl.desc", { event: e.name })} /><div className="px-5 pb-4"><Statement lines={profitAndLoss(f, t)} currency={f.currency} caption={t("pl.title")} /></div></Card>
      <Card><CardHeader title={t("flow.title")} description={t("flow.desc")} /><div className="px-5 pb-4"><Statement lines={moneyFlow(f, t)} currency={f.currency} caption={t("flow.title")} /></div></Card>
    </div>
  );
}

// ---------- reports ----------
function ReportsTab({ e }: { e: Ev }) {
  const t = useTranslations("accounting.fin.reports");
  const ensure = useElevation();
  const doExport = useExport();
  const { q } = useMode();
  const items: Array<{ k: string; url?: string; href?: string }> = [
    { k: "summary", url: `/api/accounting/finance/events?eventId=${e.id}` },
    { k: "sales", url: `/api/accounting/reports/sales?eventId=${e.id}` },
    { k: "transactions", url: `/api/accounting/transactions?eventId=${e.id}` },
    { k: "payments", url: `/api/accounting/organiser-payments?eventId=${e.id}` },
    { k: "ledger", href: `/accounting/ledger?eventId=${e.id}` },
    ...(e.organiserId ? [{ k: "statement", href: `/accounting/organisers/${e.organiserId}` }] : []),
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map((x) => (
      <Card key={x.k} className="flex flex-col justify-between gap-4 p-5">
        <div><h3 className="font-semibold">{t(`${x.k}.title`)}</h3><p className="mt-1 text-sm text-muted">{t(`${x.k}.desc`)}</p></div>
        {x.url ? <Button onClick={() => doExport(ensure, q(x.url!))}><Download className="size-4" aria-hidden />{t("csv")}</Button> : <LinkButton href={x.href!}>{t("open")}</LinkButton>}
      </Card>
    ))}</div>
  );
}

// ---------- audit ----------
function AuditTab({ eventId }: { eventId: string }) {
  const t = useTranslations("accounting.fin");
  const { data, loading } = useApi<{ items: AuditItem[] }>(`/api/accounting/events/${eventId}/audit`);
  return <Card><CardHeader title={t("audit.title")} description={t("audit.desc")} /><div className="p-5">{loading && !data ? <Skeleton className="h-24" /> : <AuditList items={data?.items ?? []} />}</div></Card>;
}
