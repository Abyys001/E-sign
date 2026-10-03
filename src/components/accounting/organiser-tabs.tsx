"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banknote, CheckCircle2, Download, Eye, FileDown, FileSignature, Link2, Pencil, ShieldAlert, ShieldCheck, Trash2, Unlink } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { PaymentEditDialog, PaymentViewDialog, type PaymentRow } from "@/components/accounting/finance";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";

export type Range = { key: RangeKey; from?: string; to?: string };
type Refund = { id: string; date: string; amount: number; currency: string; kind: string; eventName: string | null; eventCode: string | null; order: string | null; customer: string | null; status: string | null; bookingFeePart: number };
type Contract = { linkId: string; contractId: string; reference: string; name: string; status: string; active: boolean; role: "MASTER" | "EVENT_SCHEDULE" | "OTHER"; note: string | null; eventId: string | null; eventName: string | null; eventCode: string | null; completedAt: string | null; linkedAt: string };

const pdfLink = "inline-flex h-9 items-center gap-2 rounded-xl border border-line-strong px-3 text-sm font-medium hover:bg-surface-2";

// ---------- payments ----------
export function OrganiserPayments({ id, onPay, onChanged }: { id: string; onPay?: () => void; onChanged: () => void }) {
  const t = useTranslations("accounting.organisers");
  const tp = useTranslations("accounting.payments");
  const tf = useTranslations("accounting.fin");
  const toast = useToast();
  const ensure = useElevation();
  const doExport = useExport();
  const { can } = useMe();
  const { q } = useMode();
  const { data, loading, reload } = useApi<{ items: PaymentRow[] }>(q(`/api/accounting/organiser-payments?organiserId=${id}&pageSize=200`));
  const [view, setView] = useState<string | null>(null); const [edit, setEdit] = useState<PaymentRow | null>(null); const [del, setDel] = useState<PaymentRow | null>(null); const [reason, setReason] = useState("");
  const [showVoided, setShowVoided] = useState(false);
  const after = async () => { await reload(); onChanged(); };
  const voided = (data?.items ?? []).filter((p) => p.status === "VOIDED").length;
  const items = (data?.items ?? []).filter((p) => showVoided || p.status !== "VOIDED");
  const markPaid = async (p: PaymentRow) => { try { await api(`/api/accounting/organiser-payments/${p.id}`, { method: "PATCH", json: { status: "PAID" } }); toast("ok", tp("markedPaid")); await after(); } catch (x) { toast("error", errMsg(x)); } };
  const manage = can("accounting.manage");
  const totals = new Map<string, number>(); for (const p of data?.items ?? []) if (p.status === "PAID") totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.amount);
  return (
    <Card>
      <CardHeader title={t("pay.title")} description={t("pay.desc")} action={<div className="flex flex-wrap gap-2">
        {voided > 0 && <label className="inline-flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />{t("pay.showVoided", { n: voided })}</label>}
        <Button size="sm" onClick={() => doExport(ensure, q(`/api/accounting/organiser-payments?organiserId=${id}`))}><Download className="size-4" aria-hidden />CSV</Button>
        {manage && onPay && <Button size="sm" variant="primary" onClick={onPay}><Banknote className="size-4" aria-hidden />{t("recordPayment")}</Button>}</div>} />
      {loading && !data ? <div className="p-4"><Skeleton className="h-24" /></div> : !items.length ? <EmptyState title={tp("empty")} description={tp("emptyDesc")} /> : <>
        <TableWrap><Table><thead><tr><Th>{tp("date")}</Th><Th>{t("pay.event")}</Th><Th className="text-end">{tp("amount")}</Th><Th>{tp("method")}</Th><Th>{tp("reference")}</Th><Th>{tp("status")}</Th><Th><span className="sr-only">{tp("actions")}</span></Th></tr></thead>
          <tbody>{items.map((p) => <Tr key={p.id} className={p.status === "VOIDED" ? "text-muted line-through decoration-1" : ""}>
            <Td className="whitespace-nowrap">{p.paymentDate}{p.notes && <span className="block max-w-xs truncate text-xs text-muted no-underline" title={p.notes}>{p.notes}</span>}</Td>
            <Td className="min-w-48">{p.eventId ? <Link href={`/accounting/events/${p.eventId}`} className="underline-offset-4 hover:underline">{p.eventName}</Link> : <span className="text-muted">{t("pay.notEvent")}</span>}{p.eventCode && <code className="block text-xs text-muted">{p.eventCode}</code>}</Td>
            <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td>{tp(`m.${p.method}`)}</Td><Td><code className="text-xs">{p.bankReference ?? "—"}</code></Td>
            <Td><Badge s={p.status} />{p.voidReason && <span className="block text-xs">{p.voidReason}</span>}</Td>
            <Td className="text-end"><div className="flex justify-end gap-1">
              <a href={`/api/accounting/organiser-payments/${p.id}/receipt`} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm hover:bg-surface-2"><FileDown className="size-3.5" aria-hidden />{tf("receipt")}</a>
              <Button size="sm" variant="ghost" onClick={() => setView(p.id)} aria-label={tf("view")}><Eye className="size-3.5" aria-hidden /></Button>
              {manage && p.status === "PENDING" && <Button size="sm" onClick={() => markPaid(p)}><CheckCircle2 className="size-3.5" aria-hidden />{tp("markPaid")}</Button>}
              {manage && p.status !== "VOIDED" && <><Button size="sm" variant="ghost" onClick={() => setEdit(p)} aria-label={tf("editItem")}><Pencil className="size-3.5" aria-hidden /></Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) { setReason(""); setDel(p); } }} aria-label={tf("deleteItem")}><Trash2 className="size-3.5" aria-hidden /></Button></>}
            </div></Td></Tr>)}</tbody></Table></TableWrap>
        {totals.size > 0 && <p className="flex flex-wrap gap-x-6 border-t border-line px-5 py-3 text-sm">{[...totals].map(([c, v]) => <span key={c}><span className="text-muted">{t("pay.total")} ({c.toUpperCase()}): </span><Money v={v} c={c} strong /></span>)}</p>}
      </>}
      {view && <PaymentViewDialog id={view} onClose={() => setView(null)} />}
      {edit && <PaymentEditDialog p={edit} onClose={() => setEdit(null)} onSaved={() => void after()} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={tf("payDelete.title")} description={tf("payDelete.desc")} confirmLabel={tf("deleteItem")}
        onConfirm={async () => { try { await api(`/api/accounting/organiser-payments/${del!.id}/void`, { json: { reason } }); toast("ok", tp("voided")); await after(); } catch (x) { toast("error", errMsg(x)); throw x; } }}>
        <Field label={tp("voidReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(x) => setReason(x.target.value)} />}</Field>
      </ConfirmDialog>
    </Card>
  );
}

// ---------- refunds ----------
export function OrganiserRefunds({ id }: { id: string }) {
  const t = useTranslations("accounting.organisers.ref");
  const locale = useLocale();
  const { q } = useMode();
  const { data, loading } = useApi<{ refunds: Refund[] }>(q(`/api/accounting/organisers/${id}/report?format=json`));
  const totals = new Map<string, { a: number; f: number }>(); for (const r of data?.refunds ?? []) { const g = totals.get(r.currency) ?? { a: 0, f: 0 }; g.a += r.amount; g.f += r.bookingFeePart; totals.set(r.currency, g); }
  return (
    <Card>
      <CardHeader title={t("title")} description={t("desc")} action={<a href={q(`/api/accounting/refunds/pdf?organiserId=${id}`)} className={pdfLink}><FileDown className="size-4" aria-hidden />{t("pdf")}</a>} />
      {loading && !data ? <div className="p-4"><Skeleton className="h-24" /></div> : !data?.refunds.length ? <EmptyState title={t("empty")} /> : <>
        <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("event")}</Th><Th>{t("order")}</Th><Th>{t("customer")}</Th><Th>{t("type")}</Th><Th className="text-end">{t("amount")}</Th><Th className="text-end">{t("fee")}</Th></tr></thead>
          <tbody>{data.refunds.map((r) => <Tr key={r.id}>
            <Td className="whitespace-nowrap"><Link href={`/accounting/transactions/${r.id}`} className="underline-offset-4 hover:underline">{fmtDate(`${r.date}T12:00:00Z`, locale, { dateStyle: "medium" })}</Link></Td>
            <Td className="min-w-48">{r.eventName ?? "—"}{r.eventCode && <code className="block text-xs text-muted">{r.eventCode}</code>}</Td><Td><code className="text-xs">{r.order ?? "—"}</code></Td><Td>{r.customer ?? "—"}</Td>
            <Td>{r.kind === "DISPUTE" ? t("chargeback") : t("refund")}{r.status && <span className="block text-xs text-muted">{r.status}</span>}</Td>
            <Td className="text-end"><Money v={r.amount} c={r.currency} strong /></Td><Td className="text-end">{r.bookingFeePart ? <Money v={r.bookingFeePart} c={r.currency} className="text-fin-warn" /> : "—"}</Td></Tr>)}</tbody></Table></TableWrap>
        <p className="flex flex-wrap gap-x-6 border-t border-line px-5 py-3 text-sm">{[...totals].map(([c, g]) => <span key={c}>{c.toUpperCase()}: <Money v={g.a} c={c} strong />{g.f > 0 && <span className="text-muted"> · {t("fee")} <Money v={g.f} c={c} /></span>}</span>)}</p>
      </>}
    </Card>
  );
}

// ---------- reports ----------
export function OrganiserReports({ id, currencies }: { id: string; currencies: string[] }) {
  const t = useTranslations("accounting.organisers.rep");
  const ensure = useElevation();
  const doExport = useExport();
  const { q } = useMode();
  const [range, setRange] = useState<Range>({ key: "all" });
  const [cur, setCur] = useState(currencies[0] ?? "eur");
  const rq = rangeQuery(rangeFor(range.key, range));
  const items: Array<{ k: string; href?: string; csv?: string }> = [
    { k: "account", href: q(`/api/accounting/organisers/${id}/report?format=pdf${rq}`) },
    { k: "internal", href: q(`/api/accounting/organisers/${id}/report?format=pdf&internal=1${rq}`) },
    { k: "refunds", href: q(`/api/accounting/refunds/pdf?organiserId=${id}${rq}`) },
    { k: "statement", csv: q(`/api/accounting/organisers/${id}/statement?currency=${cur}${rq}`) },
    { k: "payments", csv: q(`/api/accounting/organiser-payments?organiserId=${id}`) },
  ];
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><h2 className="font-semibold">{t("title")}</h2><p className="text-sm text-muted">{t("desc")}</p></div>
        <div className="flex flex-wrap items-center gap-2"><RangePicker value={range} onChange={setRange} />
          {currencies.length > 1 && <Select aria-label="Currency" value={cur} onChange={(e) => setCur(e.target.value)} className="w-auto uppercase">{currencies.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</Select>}</div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map((x) => (
        <Card key={x.k} className="flex flex-col justify-between gap-4 p-5">
          <div><h3 className="font-semibold">{t(`${x.k}.title`)}</h3><p className="mt-1 text-sm text-muted">{t(`${x.k}.desc`)}</p></div>
          {x.href ? <a href={x.href} className={pdfLink + " justify-center"}><FileDown className="size-4" aria-hidden />{t("pdf")}</a>
            : <Button onClick={() => doExport(ensure, x.csv!)}><Download className="size-4" aria-hidden />{t("csv")}</Button>}
        </Card>
      ))}</div>
    </div>
  );
}

// ---------- contracts ----------
export function OrganiserContracts({ id, events }: { id: string; events: Array<{ id: string; name: string; code: string }> }) {
  const t = useTranslations("accounting.organisers.con");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const { data, loading, reload } = useApi<{ items: Contract[] }>(`/api/accounting/organisers/${id}/contracts`);
  const [open, setOpen] = useState(false); const [del, setDel] = useState<Contract | null>(null);
  const manage = can("accounting.manage");
  return (
    <Card>
      <CardHeader title={t("title")} description={t("desc")} action={manage && <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Link2 className="size-4" aria-hidden />{t("link")}</Button>} />
      {loading && !data ? <div className="p-4"><Skeleton className="h-24" /></div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : (
        <TableWrap><Table><thead><tr><Th>{t("reference")}</Th><Th>{t("name")}</Th><Th>{t("role")}</Th><Th>{t("event")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("unlink")}</span></Th></tr></thead>
          <tbody>{data.items.map((c) => <Tr key={c.linkId}>
            <Td><Link href={`/contracts/${c.contractId}`} className="font-mono text-xs underline-offset-4 hover:underline">{c.reference}</Link></Td>
            <Td className="min-w-56"><Link href={`/contracts/${c.contractId}`} className="font-medium underline-offset-4 hover:underline">{c.name}</Link>{c.note && <span className="block text-xs text-muted">{c.note}</span>}</Td>
            <Td>{t(`roles.${c.role}`)}</Td>
            <Td>{c.eventId ? <Link href={`/accounting/events/${c.eventId}`} className="underline-offset-4 hover:underline">{c.eventName}</Link> : "—"}{c.eventCode && <code className="block text-xs text-muted">{c.eventCode}</code>}</Td>
            <Td>{c.active ? <span className="inline-flex items-center gap-1 text-sm font-medium text-fin-pos"><ShieldCheck className="size-4" aria-hidden />{t("active")}</span> : <Badge s={c.status} />}{c.completedAt && <span className="block text-xs text-muted">{fmtDate(c.completedAt, locale, { dateStyle: "medium" })}</span>}</Td>
            <Td className="text-end">{manage && <Button size="sm" variant="ghost" onClick={() => setDel(c)} aria-label={t("unlink")}><Unlink className="size-3.5" aria-hidden /></Button>}</Td></Tr>)}</tbody></Table></TableWrap>)}
      {open && <LinkContractDialog id={id} events={events} onClose={() => setOpen(false)} onSaved={() => { toast("ok", t("linked")); void reload(); }} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("unlink")} description={del ? `${del.reference} — ${del.name}` : ""} confirmLabel={t("unlink")}
        onConfirm={async () => { try { await api(`/api/accounting/organisers/${id}/contracts`, { method: "DELETE", json: { linkId: del!.linkId } }); toast("ok", t("unlinked")); await reload(); } catch (x) { toast("error", errMsg(x)); throw x; } }} />
    </Card>
  );
}

function LinkContractDialog({ id, events, onClose, onSaved }: { id: string; events: Array<{ id: string; name: string; code: string }>; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.organisers.con");
  const [s, setS] = useState(""); const ds = useDebounced(s, 300);
  const { data } = useApi<{ candidates: Array<{ id: string; reference: string; name: string; status: string }> }>(`/api/accounting/organisers/${id}/contracts?candidates=1${ds ? `&q=${encodeURIComponent(ds)}` : ""}`);
  const [contractId, setContractId] = useState(""); const [role, setRole] = useState<Contract["role"]>("MASTER"); const [eventId, setEventId] = useState(""); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/accounting/organisers/${id}/contracts`, { json: { contractId, role, eventId: eventId || null, note: note || null } }); onSaved(); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("dialogTitle")} description={t("dialogDesc")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={!contractId || (role === "EVENT_SCHEDULE" && !eventId)} onClick={save}><FileSignature className="size-4" aria-hidden />{t("link")}</Button></>}>
      <div className="space-y-4">
        <Field label={t("search")}>{(p) => <Input {...p} value={s} onChange={(e) => setS(e.target.value)} placeholder="CTR-2026-…" />}</Field>
        <Field label={t("pick")} required>{(p) => <Select {...p} value={contractId} onChange={(e) => setContractId(e.target.value)}><option value="">{t("choose")}</option>{(data?.candidates ?? []).map((c) => <option key={c.id} value={c.id}>{c.reference} · {c.name} · {c.status}</option>)}</Select>}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("role")} required>{(p) => <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Contract["role"])}>{(["MASTER", "EVENT_SCHEDULE", "OTHER"] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}</Select>}</Field>
          <Field label={t("event")} required={role === "EVENT_SCHEDULE"}>{(p) => <Select {...p} value={eventId} onChange={(e) => setEventId(e.target.value)}><option value="">{t("noEvent")}</option>{events.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>
        </div>
        <Field label={t("note")}>{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

/** Event page: contract status (go-live control). */
export function EventContractStatus({ eventId, organiserId }: { eventId: string; organiserId: string | null }) {
  const t = useTranslations("accounting.organisers.con");
  const { data } = useApi<{ items: Contract[]; goLive: boolean }>(`/api/accounting/events/${eventId}/contracts`);
  if (!data) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{t("eventStatus")}:</span>
      {data.goLive ? <span className="inline-flex items-center gap-1 font-medium text-fin-pos"><ShieldCheck className="size-4" aria-hidden />{t("goLive")}</span>
        : <span className="inline-flex items-center gap-1 font-medium text-fin-warn"><ShieldAlert className="size-4" aria-hidden />{t("notLive")}</span>}
      {data.items.map((c) => <Link key={c.linkId} href={`/contracts/${c.contractId}`} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs underline-offset-4 hover:underline" title={`${t(`roles.${c.role}`)} · ${c.status}`}>{c.reference}</Link>)}
      {organiserId && <Link href={`/accounting/organisers/${organiserId}?tab=contracts`} className="text-xs underline underline-offset-4">{t("manage")}</Link>}
    </div>
  );
}
