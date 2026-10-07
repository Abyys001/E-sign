"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Banknote, CircleDollarSign, FileDown, HandCoins, Pencil, Plus, Trash2, TrendingUp } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { AmountCard, Badge, Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";
import { parseMajor, toDecimalString } from "@/lib/money";

type Partner = { id: string; name: string; role: string | null; email: string | null; sharePercent: number; appliesFrom: string | null; lossesCount: boolean; active: boolean; notes: string | null };
type Overview = {
  partner: Partner;
  totals: Array<{ currency: string; profit: number; earned: number; paid: number; owed: number; events: number }>;
  events: Array<{ eventId: string; code: string; name: string; date: string | null; status: string; organiser: string | null; currency: string; grossSales: number; profitBefore: number; share: number; inScope: boolean; loss: boolean }>;
  monthly: Array<{ month: string; currency: string; profit: number; share: number; events: number }>;
  payments: Array<{ id: string; paymentDate: string; amount: number; currency: string; method: string; bankReference: string | null; notes: string | null; status: string; voidReason: string | null }>;
};

export default function ProfitSharePage() {
  const t = useTranslations("accounting.pshare");
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { mode, q } = useMode();
  const partners = useApi<{ items: Partner[] }>("/api/accounting/profit-share/partners");
  const [pid, setPid] = useState<string>("");
  useEffect(() => { if (!pid && partners.data?.items[0]) setPid(partners.data.items[0].id); }, [partners.data, pid]);
  const ov = useApi<Overview>(pid ? q(`/api/accounting/profit-share/partners/${pid}`) : null);
  const [tab, setTab] = useState<"events" | "monthly" | "payments">("events");
  const [edit, setEdit] = useState<Partner | "new" | null>(null);
  const [pay, setPay] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null); const [reason, setReason] = useState("");
  const admin = can("accounting.admin"), manage = can("accounting.manage");

  if (!partners.data) return <Skeleton className="h-64" />;
  if (!partners.data.items.length) return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <EmptyState icon={<HandCoins className="size-6" aria-hidden />} title={t("noPartners")} description={t("noPartnersDesc")} action={admin ? <Button variant="primary" onClick={() => setEdit("new")}><Plus className="size-4" aria-hidden />{t("addPartner")}</Button> : undefined} />
      {edit && <PartnerDialog partner={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => void partners.reload()} />}
    </div>
  );
  const d = ov.data;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={d ? t("subPartner", { name: d.partner.name, pct: d.partner.sharePercent }) : t("sub")} actions={<>
        {partners.data.items.length > 1 && <Select aria-label={t("partner")} value={pid} onChange={(e) => setPid(e.target.value)} className="w-auto">{partners.data.items.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sharePercent}%</option>)}</Select>}
        {pid && <a href={q(`/api/accounting/profit-share/partners/${pid}/statement`)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong px-3.5 text-sm font-medium hover:bg-surface-2"><FileDown className="size-4" aria-hidden />{t("statement")}</a>}
        {admin && d && <Button onClick={() => setEdit(d.partner)}><Pencil className="size-4" aria-hidden />{t("settings")}</Button>}
        {admin && <Button variant="ghost" onClick={() => setEdit("new")}><Plus className="size-4" aria-hidden />{t("addPartner")}</Button>}
        {manage && d && <Button variant="primary" onClick={() => setPay(true)}><Banknote className="size-4" aria-hidden />{t("recordPayment")}</Button>}
      </>} />
      {!d ? <Skeleton className="h-64" /> : <>
        {!d.partner.active && <Callout tone="warn">{t("inactive")}</Callout>}
        {d.totals.length === 0 ? <Callout>{t("nothingYet")}</Callout> : d.totals.map((x) => (
          <div key={x.currency} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">{x.currency.toUpperCase()} · {t("eventsCount", { n: x.events })}</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <AmountCard label={t("profit")} v={x.profit} c={x.currency} tone="info" icon={TrendingUp} hint={t("profitHint")} />
              <AmountCard label={t("earned", { pct: d.partner.sharePercent })} v={x.earned} c={x.currency} tone="bal" icon={HandCoins} />
              <AmountCard label={t("paid")} v={x.paid} c={x.currency} tone="pos" icon={Banknote} />
              <AmountCard label={t("owed")} v={x.owed} c={x.currency} tone={x.owed > 0 ? "warn" : "pos"} icon={CircleDollarSign} hint={x.owed < 0 ? t("overpaid") : undefined} />
            </div>
          </div>
        ))}
        <Card>
          <div className="flex flex-wrap gap-1.5 border-b border-line px-5 py-3">
            {(["events", "monthly", "payments"] as const).map((k) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)} className={`rounded-full border px-3 py-1 text-sm ${tab === k ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg"}`}>{t(`tab.${k}`)}{k === "payments" ? ` (${d.payments.filter((p) => p.status === "PAID").length})` : ""}</button>)}
          </div>
          {tab === "events" && (!d.events.length ? <EmptyState title={t("noEvents")} /> : <TableWrap><Table><thead><tr><Th>{t("event")}</Th><Th>{t("date")}</Th><Th>{t("organiser")}</Th><Th className="text-end">{t("gross")}</Th><Th className="text-end">{t("profit")}</Th><Th className="text-end">{t("share")}</Th></tr></thead>
            <tbody>{d.events.map((e) => <Tr key={`${e.eventId}-${e.currency}`} className={!e.inScope ? "text-muted" : ""}>
              <Td className="min-w-52"><Link href={`/accounting/events/${e.eventId}`} className="font-medium underline-offset-4 hover:underline">{e.name}</Link><code className="block text-xs text-muted">{e.code}{e.status === "CANCELLED" ? ` · ${t("cancelled")}` : ""}</code></Td>
              <Td className="whitespace-nowrap">{e.date ?? "—"}</Td><Td className="text-sm">{e.organiser ?? "—"}</Td>
              <Td className="text-end"><Money v={e.grossSales} c={e.currency} /></Td>
              <Td className="text-end"><Money v={e.profitBefore} c={e.currency} className={e.loss ? "text-fin-neg" : ""} /></Td>
              <Td className="text-end"><Money v={e.share} c={e.currency} strong />{e.loss && !d.partner.lossesCount && <span className="block text-xs text-muted">{t("lossZero")}</span>}{!e.inScope && <span className="block text-xs">{t("outOfScope")}</span>}</Td>
            </Tr>)}</tbody></Table></TableWrap>)}
          {tab === "monthly" && <TableWrap><Table><thead><tr><Th>{t("month")}</Th><Th>{t("currency")}</Th><Th className="text-end">{t("events")}</Th><Th className="text-end">{t("profit")}</Th><Th className="text-end">{t("share")}</Th></tr></thead>
            <tbody>{d.monthly.map((m) => <Tr key={`${m.month}-${m.currency}`}><Td className="font-medium">{m.month}</Td><Td className="uppercase">{m.currency}</Td><Td className="text-end">{m.events}</Td><Td className="text-end"><Money v={m.profit} c={m.currency} /></Td><Td className="text-end"><Money v={m.share} c={m.currency} strong /></Td></Tr>)}</tbody></Table></TableWrap>}
          {tab === "payments" && (!d.payments.length ? <EmptyState title={t("noPayments")} description={t("noPaymentsDesc")} /> : <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("reference")}</Th><Th>{t("notes")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{d.payments.map((p) => <Tr key={p.id} className={p.status === "VOIDED" ? "text-muted line-through decoration-1" : ""}>
              <Td className="whitespace-nowrap">{p.paymentDate}</Td><Td><code className="text-xs">{p.bankReference ?? "—"}</code></Td><Td className="max-w-xs truncate text-sm" title={p.notes ?? ""}>{p.notes ?? "—"}</Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><Badge s={p.status} />{p.voidReason && <span className="block text-xs">{p.voidReason}</span>}</Td>
              <Td className="text-end">{manage && p.status !== "VOIDED" && <Button size="sm" variant="ghost" aria-label={t("void")} onClick={async () => { if (await ensure()) { setReason(""); setVoiding(p.id); } }}><Trash2 className="size-3.5" aria-hidden /></Button>}</Td>
            </Tr>)}</tbody></Table></TableWrap>)}
        </Card>
        <p className="text-xs text-muted">{t("howItWorks", { pct: d.partner.sharePercent })}</p>
      </>}
      {edit && <PartnerDialog partner={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={async (id) => { await partners.reload(); setPid(id); await ov.reload(); }} />}
      {pay && d && <PartnerPaymentDialog partnerId={d.partner.id} mode={mode} owed={d.totals} onClose={() => setPay(false)} onSaved={() => void ov.reload()} />}
      <ConfirmDialog open={!!voiding} onClose={() => setVoiding(null)} title={t("voidTitle")} description={t("voidDesc")} confirmLabel={t("void")}
        onConfirm={async () => { try { await api(`/api/accounting/profit-share/payments/${voiding}/void`, { json: { reason } }); toast("ok", t("voided")); await ov.reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("reason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}

function PartnerDialog({ partner, onClose, onSaved }: { partner: Partner | null; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useTranslations("accounting.pshare");
  const c = useTranslations("common");
  const [v, setV] = useState({ name: partner?.name ?? "", role: partner?.role ?? "", email: partner?.email ?? "", pct: String(partner?.sharePercent ?? 10), appliesFrom: partner?.appliesFrom ?? "", lossesCount: partner?.lossesCount ?? false, active: partner?.active ?? true, notes: partner?.notes ?? "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const json = { name: v.name, role: v.role || null, email: v.email || null, sharePercent: Number(v.pct), appliesFrom: v.appliesFrom || null, lossesCount: v.lossesCount, active: v.active, notes: v.notes || null };
      const r = await api<{ id: string }>(partner ? `/api/accounting/profit-share/partners/${partner.id}` : "/api/accounting/profit-share/partners", partner ? { method: "PATCH", json } : { json });
      onSaved(r.id); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={partner ? t("editPartner") : t("addPartner")} description={t("partnerDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name || !(Number(v.pct) >= 0 && Number(v.pct) <= 100)} onClick={save}>{c("save")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("name")} required>{(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Morteza" />}</Field>
        <Field label={t("role")}>{(p) => <Input {...p} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} placeholder={t("rolePh")} />}</Field>
        <Field label={t("percent")} required hint={t("percentHint")}>{(p) => <Input {...p} inputMode="decimal" value={v.pct} onChange={(e) => setV({ ...v, pct: e.target.value })} />}</Field>
        <Field label={t("appliesFrom")} hint={t("appliesFromHint")}>{(p) => <Input {...p} type="date" value={v.appliesFrom} onChange={(e) => setV({ ...v, appliesFrom: e.target.value })} />}</Field>
        <Field label={t("email")}>{(p) => <Input {...p} type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />}</Field>
        <div className="space-y-2 pt-6"><Checkbox label={t("lossesCount")} checked={v.lossesCount} onChange={(e) => setV({ ...v, lossesCount: e.target.checked })} /><Checkbox label={t("active")} checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /></div>
        <div className="sm:col-span-2"><Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} className="min-h-14" />}</Field></div>
        {partner && <p className="text-xs text-muted sm:col-span-2">{t("changeNote")}</p>}
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}

function PartnerPaymentDialog({ partnerId, mode, owed, onClose, onSaved }: { partnerId: string; mode: string; owed: Overview["totals"]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.pshare");
  const c = useTranslations("common");
  const toast = useToast();
  const first = owed.find((x) => x.owed > 0) ?? owed[0];
  const [v, setV] = useState({ amount: "", currency: first?.currency ?? "eur", paymentDate: new Date().toISOString().slice(0, 10), method: "BANK_TRANSFER", bankReference: "", notes: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const cur = owed.find((x) => x.currency === v.currency);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api("/api/accounting/profit-share/payments", { json: { mode, partnerId, amount: parseMajor(v.amount, v.currency), currency: v.currency, paymentDate: v.paymentDate, method: v.method, bankReference: v.bankReference || null, notes: v.notes || null } }); toast("ok", t("paymentRecorded")); onSaved(); onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={t("recordPayment")} description={t("paymentDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.amount || !v.paymentDate} onClick={save}>{t("recordPayment")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("amount")} required hint={cur ? t("owedHint", { owed: `${toDecimalString(cur.owed, cur.currency)} ${cur.currency.toUpperCase()}` }) : undefined}>{(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
        <Field label={t("currency")} required hint={t("currencyHint")}>{(p) => <Input {...p} value={v.currency} maxLength={3} onChange={(e) => setV({ ...v, currency: e.target.value.toLowerCase() })} className="uppercase" />}</Field>
        <Field label={t("date")} required>{(p) => <Input {...p} type="date" value={v.paymentDate} onChange={(e) => setV({ ...v, paymentDate: e.target.value })} />}</Field>
        <Field label={t("method")}>{(p) => <Select {...p} value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>{["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"].map((m) => <option key={m} value={m}>{t(`m.${m}`)}</option>)}</Select>}</Field>
        <div className="sm:col-span-2"><Field label={t("reference")} hint={t("referenceHint")}>{(p) => <Input {...p} value={v.bankReference} onChange={(e) => setV({ ...v, bankReference: e.target.value })} placeholder="Wise #…" />}</Field></div>
        <div className="sm:col-span-2"><Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} className="min-h-14" />}</Field></div>
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}
