"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, Download, Lock, LockOpen, Plus, Undo2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, Money, RangePicker, rangeFor, rangeQuery, useExport, useMode, type RangeKey } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { parseMajor } from "@/lib/money";

type Line = { id: number; accountCode: string; accountName: string; debit: number; credit: number; memo: string | null };
type Entry = { id: string; seq: number; entryType: string; entryDate: string; currency: string; description: string; reference: string | null; status: string; reason: string | null; createdByName: string | null; stripeBalanceTransactionId: string | null; lines: Line[] };
type Acc = { id: string; code: string; name: string; type: string; systemKey: string | null };
type TB = { accountId: string; code: string; name: string; type: string; currency: string; debit: number; credit: number; balance: number };
const TYPES = ["SALE", "SALE_UNALLOCATED", "REFUND", "DISPUTE", "DISPUTE_REVERSAL", "STRIPE_FEE", "PAYOUT", "PAYOUT_PAID", "PAYOUT_REVERSAL", "STRIPE_OTHER", "ORGANISER_PAYMENT", "ADJUSTMENT", "EVENT_FEE", "REVERSAL"];

export default function LedgerPage() {
  const t = useTranslations("accounting.ledger");
  const [tab, setTab] = useState<"journal" | "trial" | "periods">("journal");
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <Tabs label={t("title")} value={tab} onChange={setTab} tabs={[{ id: "journal", label: t("tabs.journal") }, { id: "trial", label: t("tabs.trial") }, { id: "periods", label: t("tabs.periods") }]} />
      <div className="mt-5">{tab === "journal" ? <Journal /> : tab === "trial" ? <Trial /> : <Periods />}</div>
    </div>
  );
}

function Journal() {
  const t = useTranslations("accounting.ledger");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const exp = useExport();
  const { can } = useMe();
  const { q } = useMode();
  const [type, setType] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState<Record<string, boolean>>({});
  const [range, setRange] = useState<{ key: RangeKey; from?: string; to?: string }>({ key: "month" });
  const [adj, setAdj] = useState(false); const [rev, setRev] = useState<Entry | null>(null); const [reason, setReason] = useState("");
  const f = `${type ? `&entryType=${type}` : ""}${rangeQuery(rangeFor(range.key, range))}`;
  const { data, loading, reload } = useApi<{ items: Entry[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/ledger?page=${page}&pageSize=50${f}`));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label={t("type")} value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-auto"><option value="">{t("allTypes")}</option>{TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
        <RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
        <div className="ms-auto flex gap-2"><Button onClick={() => exp(ensure, q(`/api/accounting/ledger?x=1${f}`))}><Download className="size-4" aria-hidden />{t("export")}</Button>
          {can("accounting.manage") && <Button variant="primary" onClick={() => setAdj(true)}><Plus className="size-4" aria-hidden />{t("adjustment")}</Button>}</div>
      </div>
      <Card>
        {loading && !data ? <Skeleton className="m-4 h-32" /> : !data?.items.length ? <EmptyState title={t("empty")} /> : <>
          <ul className="divide-y divide-line">{data.items.map((e) => {
            const total = e.lines.reduce((s, l) => s + l.debit, 0);
            // The transaction's size is its largest line (gross sale, refund, payment…); the debit total double-counts by design.
            const amount = e.lines.reduce((m, l) => Math.max(m, l.debit, l.credit), 0);
            return <li key={e.id}>
              <button type="button" aria-expanded={!!open[e.id]} onClick={() => setOpen({ ...open, [e.id]: !open[e.id] })} className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-start text-sm hover:bg-surface-2/70">
                <ChevronDown className={cn("size-4 shrink-0 transition", open[e.id] && "rotate-180")} aria-hidden /><span className="num w-14 text-muted">#{e.seq}</span><span className="w-24">{e.entryDate}</span><span className="w-40 text-xs font-medium">{e.entryType}</span>
                <span className="min-w-0 flex-1 truncate">{e.description}</span><Money v={amount} c={e.currency} strong /><Badge s={e.status} />
              </button>
              {open[e.id] && <div className="border-t border-line bg-surface-2/40 px-5 py-3">
                <TableWrap><Table><thead><tr><Th>{t("account")}</Th><Th>{t("memo")}</Th><Th className="text-end">{t("debit")}</Th><Th className="text-end">{t("credit")}</Th></tr></thead>
                  <tbody>{e.lines.map((l) => <Tr key={l.id}><Td><code className="text-xs">{l.accountCode}</code> {l.accountName}</Td><Td className="text-muted">{l.memo}</Td><Td className="text-end">{l.debit ? <Money v={l.debit} c={e.currency} /> : ""}</Td><Td className="text-end">{l.credit ? <Money v={l.credit} c={e.currency} /> : ""}</Td></Tr>)}</tbody></Table></TableWrap>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted"><span>{t("balancedTotal")}: <Money v={total} c={e.currency} /></span>{e.reference && <span>{t("reference")}: <code>{e.reference}</code></span>}{e.stripeBalanceTransactionId && <span>Stripe: <code>{e.stripeBalanceTransactionId}</code></span>}{e.createdByName && <span>{t("by")} {e.createdByName}</span>}{e.reason && <span>{t("reason")}: {e.reason}</span>}
                  {can("accounting.admin") && e.status === "POSTED" && ["ADJUSTMENT", "EVENT_FEE"].includes(e.entryType) && <Button size="sm" variant="ghost" className="ms-auto" onClick={async () => { if (await ensure()) { setReason(""); setRev(e); } }}><Undo2 className="size-3.5" aria-hidden />{t("reverse")}</Button>}</div>
              </div>}
            </li>;
          })}</ul>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {adj && <AdjustmentDialog onClose={() => setAdj(false)} onSaved={reload} />}
      <ConfirmDialog open={!!rev} onClose={() => setRev(null)} title={t("reverseTitle")} description={t("reverseDesc")} confirmLabel={t("reverse")}
        onConfirm={async () => { try { await api(`/api/accounting/ledger/${rev!.id}/reverse`, { json: { reason } }); toast("ok", t("reversed")); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("reason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
      <span className="sr-only">{locale}</span>
    </>
  );
}

function AdjustmentDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.ledger.adj");
  const c = useTranslations("common");
  const toast = useToast();
  const { mode } = useMode();
  const { data: acc } = useApi<{ accounts: Acc[] }>("/api/accounting/accounts");
  const { data: evs } = useApi<{ items: Array<{ id: string; name: string; code: string; organiserId: string | null }> }>("/api/accounting/events?pageSize=200");
  const { data: orgs } = useApi<{ items: Array<{ id: string; name: string }> }>("/api/accounting/organisers?pageSize=200");
  const [key] = useState(() => crypto.randomUUID());
  const [v, setV] = useState({ preset: "income", date: new Date().toISOString().slice(0, 10), currency: "eur", amount: "", debitAccountId: "", creditAccountId: "", eventId: "", organiserId: "", description: "", reason: "", reference: "" });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const accounts = (acc?.accounts ?? []).filter((a) => a.systemKey !== "stripe_balance");
  const sys = (k: string) => accounts.find((a) => a.systemKey === k)?.id ?? "";
  const preset = (p: string) => {
    const map: Record<string, [string, string]> = { income: [sys("bank"), sys("other_revenue")], expense: [sys("other_expenses"), sys("bank")], organiserCharge: [sys("organiser_payable"), sys("bilit_commission")], organiserCredit: [sys("other_expenses"), sys("organiser_payable")], custom: [v.debitAccountId, v.creditAccountId] };
    const [d, cr] = map[p]!;
    setV({ ...v, preset: p, debitAccountId: d, creditAccountId: cr });
  };
  const set = (k: keyof typeof v, x: string) => setV({ ...v, [k]: x });
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const amount = parseMajor(v.amount, v.currency);
      await api("/api/accounting/adjustments", { json: { mode, date: v.date, currency: v.currency, amount, debitAccountId: v.debitAccountId || sys("bank"), creditAccountId: v.creditAccountId || sys("other_revenue"), eventId: v.eventId || null, organiserId: v.organiserId || null, description: v.description, reason: v.reason, reference: v.reference || null }, idempotencyKey: key });
      toast("ok", t("saved")); onSaved(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("title")} description={t("desc", { mode: mode.toUpperCase() })}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.amount || v.description.length < 3 || v.reason.length < 3} onClick={submit}>{t("post")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label={t("preset")}>{(p) => <Select {...p} value={v.preset} onChange={(e) => preset(e.target.value)}>{["income", "expense", "organiserCharge", "organiserCredit", "custom"].map((x) => <option key={x} value={x}>{t(`presets.${x}`)}</option>)}</Select>}</Field></div>
        <Field label={t("debit")} required>{(p) => <Select {...p} value={v.debitAccountId || sys("bank")} onChange={(e) => setV({ ...v, preset: "custom", debitAccountId: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        <Field label={t("credit")} required>{(p) => <Select {...p} value={v.creditAccountId || sys("other_revenue")} onChange={(e) => setV({ ...v, preset: "custom", creditAccountId: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        <Field label={t("amount")} required>{(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} placeholder="500.00" />}</Field>
        <Field label={t("currency")} required>{(p) => <Input {...p} value={v.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toLowerCase())} className="uppercase" />}</Field>
        <Field label={t("date")} required>{(p) => <Input {...p} type="date" value={v.date} onChange={(e) => set("date", e.target.value)} />}</Field>
        <Field label={t("reference")}>{(p) => <Input {...p} value={v.reference} onChange={(e) => set("reference", e.target.value)} />}</Field>
        <Field label={t("event")}>{(p) => <Select {...p} value={v.eventId} onChange={(e) => { const ev = evs?.items.find((x) => x.id === e.target.value); setV({ ...v, eventId: e.target.value, organiserId: ev?.organiserId ?? v.organiserId }); }}><option value="">—</option>{evs?.items.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>
        <Field label={t("organiser")}>{(p) => <Select {...p} value={v.organiserId} onChange={(e) => set("organiserId", e.target.value)}><option value="">—</option>{orgs?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
        <div className="sm:col-span-2"><Field label={t("description")} required>{(p) => <Input {...p} value={v.description} onChange={(e) => set("description", e.target.value)} placeholder={t("descriptionPh")} />}</Field></div>
        <div className="sm:col-span-2"><Field label={t("reason")} required>{(p) => <Textarea {...p} value={v.reason} onChange={(e) => set("reason", e.target.value)} className="min-h-16" />}</Field></div>
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}

function Trial() {
  const t = useTranslations("accounting.ledger");
  const { q } = useMode();
  const [to, setTo] = useState("");
  const { data, loading } = useApi<{ accounts: Acc[]; trialBalance: TB[] }>(q(`/api/accounting/accounts?x=1${to ? `&to=${to}` : ""}`));
  const byCur = new Map<string, TB[]>();
  for (const r of data?.trialBalance ?? []) byCur.set(r.currency, [...(byCur.get(r.currency) ?? []), r]);
  return (
    <div className="space-y-4">
      <Field label={t("asOf")}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />}</Field>
      {loading && !data ? <Skeleton className="h-32" /> : byCur.size === 0 ? <Card><EmptyState title={t("empty")} /></Card> : [...byCur].map(([cur, rows]) => {
        const d = rows.reduce((s, r) => s + r.debit, 0), cr = rows.reduce((s, r) => s + r.credit, 0);
        return <Card key={cur}><CardHeader title={`${t("trial")} · ${cur.toUpperCase()}`} action={d === cr ? <Badge s="MATCHED" /> : <Badge s="ERROR" />} />
          <TableWrap><Table><thead><tr><Th>{t("code")}</Th><Th>{t("account")}</Th><Th>{t("accType")}</Th><Th className="text-end">{t("debit")}</Th><Th className="text-end">{t("credit")}</Th><Th className="text-end">{t("balance")}</Th></tr></thead>
            <tbody>{rows.map((r) => <Tr key={r.accountId}><Td><code className="text-xs">{r.code}</code></Td><Td>{r.name}</Td><Td className="text-xs text-muted">{r.type}</Td><Td className="text-end"><Money v={r.debit} c={cur} /></Td><Td className="text-end"><Money v={r.credit} c={cur} /></Td><Td className="text-end"><Money v={r.balance} c={cur} strong /></Td></Tr>)}
              <Tr className="font-semibold"><Td colSpan={3}>{t("totals")}</Td><Td className="text-end"><Money v={d} c={cur} strong /></Td><Td className="text-end"><Money v={cr} c={cur} strong /></Td><Td /></Tr></tbody></Table></TableWrap>
        </Card>;
      })}
    </div>
  );
}

function Periods() {
  const t = useTranslations("accounting.ledger.periods");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { data, reload } = useApi<{ items: Array<{ id: string; period: string; status: string; closedAt: string | null; closedByName: string | null; notes: string | null }> }>("/api/accounting/periods");
  const [period, setPeriod] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); });
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const act = async (p: string, action: "close" | "reopen") => {
    if (!(await ensure())) return;
    setBusy(true);
    try { await api("/api/accounting/periods", { json: { period: p, action, reason } }); toast("ok", t(action === "close" ? "closed" : "reopened")); setReason(""); await reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Callout title={t("title")}>{t("desc")}</Callout>
      {can("accounting.admin") && <Card className="p-5"><div className="flex flex-wrap items-end gap-3">
        <Field label={t("period")}>{(p) => <Input {...p} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-auto" />}</Field>
        <div className="min-w-64 flex-1"><Field label={t("reason")} required>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field></div>
        <Button variant="primary" loading={busy} disabled={reason.length < 3 || !period} onClick={() => act(period, "close")}><Lock className="size-4" aria-hidden />{t("close")}</Button></div></Card>}
      <Card>{!data?.items.length ? <EmptyState title={t("none")} /> : <TableWrap><Table><thead><tr><Th>{t("period")}</Th><Th>{t("status")}</Th><Th>{t("closedBy")}</Th><Th>{t("notes")}</Th><Th /></tr></thead>
        <tbody>{data.items.map((p) => <Tr key={p.id}><Td className="num">{p.period}</Td><Td><Badge s={p.status} /></Td><Td>{p.closedByName ? `${p.closedByName} · ${fmtDate(p.closedAt, locale)}` : "—"}</Td><Td className="text-muted">{p.notes}</Td>
          <Td className="text-end">{can("accounting.admin") && <Button size="sm" disabled={reason.length < 3 || busy} title={reason.length < 3 ? t("reasonFirst") : undefined} onClick={() => act(p.period, p.status === "CLOSED" ? "reopen" : "close")}>{p.status === "CLOSED" ? <><LockOpen className="size-3.5" aria-hidden />{t("reopen")}</> : <><Lock className="size-3.5" aria-hidden />{t("close")}</>}</Button>}</Td></Tr>)}</tbody></Table></TableWrap>}</Card>
    </div>
  );
}
