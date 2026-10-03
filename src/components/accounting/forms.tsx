"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";
import { bpsToPercent, parseMajor, percentToBps, toDecimalString } from "@/lib/money";

type FieldErrors = Record<string, string>;
const fieldErrors = (e: unknown): FieldErrors => (e instanceof ApiError && Array.isArray(e.details) ? Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])) : {});

// ---------- agreement (commission model) ----------
export type AgreementValue = { percent: string; percentBasis: "ADDED" | "GROSS" | "NET"; fixedPerTicket: string; fixedEventFee: string; stripeFeesBorneBy: "ORGANISER" | "BILIT"; chargebacksBorneBy: "ORGANISER" | "BILIT"; refundsReverseCommission: boolean; notes: string };
export const emptyAgreement = (): AgreementValue => ({ percent: "0", percentBasis: "ADDED", fixedPerTicket: "0", fixedEventFee: "0", stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: "" });
export const agreementFrom = (a: { percentBps: number; percentBasis: string; fixedPerTicket: number; fixedEventFee: number; stripeFeesBorneBy: string; chargebacksBorneBy: string; refundsReverseCommission: boolean; notes: string | null }, currency: string): AgreementValue => ({
  percent: bpsToPercent(a.percentBps), percentBasis: a.percentBasis as "GROSS", fixedPerTicket: toDecimalString(a.fixedPerTicket, currency), fixedEventFee: toDecimalString(a.fixedEventFee, currency),
  stripeFeesBorneBy: a.stripeFeesBorneBy as "ORGANISER", chargebacksBorneBy: a.chargebacksBorneBy as "ORGANISER", refundsReverseCommission: a.refundsReverseCommission, notes: a.notes ?? "",
});
export function agreementPayload(v: AgreementValue, currency: string) {
  return { percentBps: percentToBps(v.percent), percentBasis: v.percentBasis, fixedPerTicket: parseMajor(v.fixedPerTicket || "0", currency), fixedEventFee: parseMajor(v.fixedEventFee || "0", currency), stripeFeesBorneBy: v.stripeFeesBorneBy, chargebacksBorneBy: v.chargebacksBorneBy, refundsReverseCommission: v.refundsReverseCommission, notes: v.notes || null };
}

export function AgreementFields({ v, onChange, currency }: { v: AgreementValue; onChange: (v: AgreementValue) => void; currency: string }) {
  const t = useTranslations("accounting.agreement");
  const set = <K extends keyof AgreementValue>(k: K, x: AgreementValue[K]) => onChange({ ...v, [k]: x });
  const cur = currency.toUpperCase();
  return (
    <fieldset className="space-y-4 rounded-xl border border-line p-4">
      <legend className="px-1 text-sm font-semibold">{t("title")}</legend>
      <p className="text-xs text-muted">{t("help")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("percent")} hint={t("percentHint")}>{(p) => <Input {...p} inputMode="decimal" value={v.percent} onChange={(e) => set("percent", e.target.value)} />}</Field>
        <Field label={t("basis")}>{(p) => <Select {...p} value={v.percentBasis} onChange={(e) => set("percentBasis", e.target.value as "GROSS")}><option value="ADDED">{t("added")}</option><option value="GROSS">{t("gross")}</option><option value="NET">{t("net")}</option></Select>}</Field>
        <Field label={`${t("perTicket")} (${cur})`} hint={t("perTicketHint")}>{(p) => <Input {...p} inputMode="decimal" value={v.fixedPerTicket} onChange={(e) => set("fixedPerTicket", e.target.value)} />}</Field>
        <Field label={`${t("eventFee")} (${cur})`} hint={t("eventFeeHint")}>{(p) => <Input {...p} inputMode="decimal" value={v.fixedEventFee} onChange={(e) => set("fixedEventFee", e.target.value)} />}</Field>
        <Field label={t("feesBy")}>{(p) => <Select {...p} value={v.stripeFeesBorneBy} onChange={(e) => set("stripeFeesBorneBy", e.target.value as "ORGANISER")}><option value="ORGANISER">{t("organiser")}</option><option value="BILIT">{t("bilit")}</option></Select>}</Field>
        <Field label={t("chargebacksBy")}>{(p) => <Select {...p} value={v.chargebacksBorneBy} onChange={(e) => set("chargebacksBorneBy", e.target.value as "ORGANISER")}><option value="ORGANISER">{t("organiser")}</option><option value="BILIT">{t("bilit")}</option></Select>}</Field>
      </div>
      <Checkbox label={t("reverse")} checked={v.refundsReverseCommission} onChange={(e) => set("refundsReverseCommission", e.target.checked)} />
      <Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field>
    </fieldset>
  );
}

// ---------- event ----------
type Org = { id: string; name: string };
export type EventValue = { name: string; code: string; currency: string; organiserId: string; startsOn: string; status: string; notes: string };

export function EventDialog({ open, onClose, onSaved, initial, eventId }: { open: boolean; onClose: () => void; onSaved: (id: string) => void; initial?: EventValue; eventId?: string }) {
  const t = useTranslations("accounting.events");
  const c = useTranslations("common");
  const toast = useToast();
  const { data: orgs } = useApi<{ items: Org[] }>(open ? "/api/accounting/organisers?pageSize=200&active=true" : null);
  const [v, setV] = useState<EventValue>(initial ?? { name: "", code: "", currency: "eur", organiserId: "", startsOn: "", status: "ACTIVE", notes: "" });
  const [ag, setAg] = useState<AgreementValue>(emptyAgreement());
  const [reason, setReason] = useState("");
  const [errs, setErrs] = useState<FieldErrors>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EventValue>(k: K, x: EventValue[K]) => setV({ ...v, [k]: x });
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try {
      const base = { name: v.name, code: v.code, currency: v.currency, organiserId: v.organiserId || null, startsOn: v.startsOn || null, status: v.status, notes: v.notes || null };
      const r = eventId ? await api<{ id: string }>(`/api/accounting/events/${eventId}`, { method: "PATCH", json: { ...base, reason: reason || null } })
        : await api<{ id: string }>("/api/accounting/events", { json: { ...base, agreement: agreementPayload(ag, v.currency) } });
      toast("ok", c("saved")); onSaved(r.id); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title={eventId ? t("edit") : t("create")} description={t("formDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name || !v.code || !v.currency} onClick={submit}>{c("save")}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")} required error={errs.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
          <Field label={t("code")} required hint={t("codeHint")} error={errs.code}>{(p) => <Input {...p} value={v.code} onChange={(e) => set("code", e.target.value.toUpperCase())} className="font-mono" />}</Field>
          <Field label={t("currency")} required error={errs.currency} hint={t("currencyHint")}>{(p) => <Input {...p} value={v.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toLowerCase())} className="uppercase" />}</Field>
          <Field label={t("organiser")} error={errs.organiserId} hint={t("organiserHint")}>{(p) => <Select {...p} value={v.organiserId} onChange={(e) => set("organiserId", e.target.value)}><option value="">{t("noOrganiser")}</option>{orgs?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
          <Field label={t("startsOn")}>{(p) => <Input {...p} type="date" value={v.startsOn} onChange={(e) => set("startsOn", e.target.value)} />}</Field>
          <Field label={t("status")}>{(p) => <Select {...p} value={v.status} onChange={(e) => set("status", e.target.value)}>{["ACTIVE", "INACTIVE", "ARCHIVED"].map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>}</Field>
        </div>
        <Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field>
        {!eventId && <AgreementFields v={ag} onChange={setAg} currency={v.currency || "eur"} />}
        {eventId && <Field label={t("changeReason")} hint={t("changeReasonHint")} error={errs.reason}>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

// ---------- organiser ----------
export type OrganiserValue = { name: string; email: string; companyName: string; vatNumber: string; address: string; internalRef: string; notes: string; active: boolean };
type Bank = { accountHolder: string; iban: string; bic: string; bankName: string; notes: string };
const emptyBank = (): Bank => ({ accountHolder: "", iban: "", bic: "", bankName: "", notes: "" });

export function OrganiserDialog({ open, onClose, onSaved, initial, organiserId, hasBank }: { open: boolean; onClose: () => void; onSaved: (id: string) => void; initial?: OrganiserValue; organiserId?: string; hasBank?: boolean }) {
  const t = useTranslations("accounting.organisers");
  const c = useTranslations("common");
  const toast = useToast();
  const [v, setV] = useState<OrganiserValue>(initial ?? { name: "", email: "", companyName: "", vatNumber: "", address: "", internalRef: "", notes: "", active: true });
  const [editBank, setEditBank] = useState(!organiserId);
  const [bank, setBank] = useState<Bank>(emptyBank());
  const [errs, setErrs] = useState<FieldErrors>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof OrganiserValue>(k: K, x: OrganiserValue[K]) => setV({ ...v, [k]: x });
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try {
      const anyBank = Object.values(bank).some((x) => x.trim());
      const payload = { ...v, email: v.email || null, ...(editBank ? { bankDetails: anyBank ? bank : null } : {}) };
      const r = organiserId ? await api<{ id: string }>(`/api/accounting/organisers/${organiserId}`, { method: "PATCH", json: payload }) : await api<{ id: string }>("/api/accounting/organisers", { json: payload });
      toast("ok", c("saved")); onSaved(r.id); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const B = (k: keyof Bank, label: string) => <Field label={label}>{(p) => <Input {...p} value={bank[k]} autoComplete="off" onChange={(e) => setBank({ ...bank, [k]: e.target.value })} />}</Field>;
  return (
    <Modal open={open} onClose={onClose} size="lg" title={organiserId ? t("edit") : t("create")} description={t("formDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name} onClick={submit}>{c("save")}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")} required error={errs.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
          <Field label={t("email")} error={errs.email}>{(p) => <Input {...p} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
          <Field label={t("company")}>{(p) => <Input {...p} value={v.companyName} onChange={(e) => set("companyName", e.target.value)} />}</Field>
          <Field label={t("vat")}>{(p) => <Input {...p} value={v.vatNumber} onChange={(e) => set("vatNumber", e.target.value)} />}</Field>
          <Field label={t("internalRef")} hint={t("internalRefHint")} error={errs.internalRef}>{(p) => <Input {...p} value={v.internalRef} onChange={(e) => set("internalRef", e.target.value)} />}</Field>
          <div className="flex items-end pb-2"><Checkbox label={t("active")} checked={v.active} onChange={(e) => set("active", e.target.checked)} /></div>
        </div>
        <Field label={t("address")}>{(p) => <Textarea {...p} value={v.address} onChange={(e) => set("address", e.target.value)} className="min-h-16" />}</Field>
        <fieldset className="space-y-3 rounded-xl border border-line p-4">
          <legend className="px-1 text-sm font-semibold">{t("bank")}</legend>
          <p className="text-xs text-muted">{t("bankHelp")}</p>
          {!editBank ? <Button size="sm" onClick={() => setEditBank(true)}>{hasBank ? t("replaceBank") : t("addBank")}</Button> : <div className="grid gap-3 sm:grid-cols-2">{B("accountHolder", t("holder"))}{B("iban", t("iban"))}{B("bic", t("bic"))}{B("bankName", t("bankName"))}<div className="sm:col-span-2">{B("notes", t("bankNotes"))}</div></div>}
        </fieldset>
        <Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

// ---------- organiser payment ----------
export type PaymentPrefill = { amount: number; currency: string; paymentDate: string; bankReference: string; method: string; notes?: string };
export function PaymentDialog({ open, onClose, onSaved, mode, organiserId, prefill }: { open: boolean; onClose: () => void; onSaved: () => void; mode: string; organiserId?: string; prefill?: PaymentPrefill }) {
  const t = useTranslations("accounting.payments");
  const c = useTranslations("common");
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ organiserId: organiserId ?? "", eventId: "", amount: prefill ? toDecimalString(prefill.amount, prefill.currency) : "", currency: prefill?.currency ?? "eur", paymentDate: prefill?.paymentDate ?? today, bankReference: prefill?.bankReference ?? "", method: prefill?.method ?? "BANK_TRANSFER", notes: prefill?.notes ?? "", status: "PAID" });
  const { data: orgs } = useApi<{ items: Org[] }>(open ? "/api/accounting/organisers?pageSize=200" : null);
  const { data: evs } = useApi<{ items: Array<{ id: string; name: string; code: string; currency: string }> }>(open && v.organiserId ? `/api/accounting/events?pageSize=200&organiserId=${v.organiserId}` : null);
  const [errs, setErrs] = useState<FieldErrors>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, x: string) => setV((o) => ({ ...o, [k]: x }));
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try {
      let amount: number;
      try { amount = parseMajor(v.amount, v.currency); } catch (e) { setErrs({ amount: errMsg(e) }); return; }
      await api("/api/accounting/organiser-payments", { json: { mode, organiserId: v.organiserId, eventId: v.eventId || null, amount, currency: v.currency, paymentDate: v.paymentDate, bankReference: v.bankReference || null, method: v.method, notes: v.notes || null, status: v.status } });
      toast("ok", t("recorded")); onSaved(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title={t("record")} description={t("recordDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.organiserId || !v.amount || !v.paymentDate} onClick={submit}>{t("record")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("organiser")} required error={errs.organiserId}>{(p) => <Select {...p} value={v.organiserId} onChange={(e) => { set("organiserId", e.target.value); set("eventId", ""); }}><option value="">—</option>{orgs?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
        <Field label={t("event")} error={errs.eventId} hint={t("eventHint")}>{(p) => <Select {...p} value={v.eventId} onChange={(e) => { const ev = evs?.items.find((x) => x.id === e.target.value); set("eventId", e.target.value); if (ev && !prefill) set("currency", ev.currency); }}><option value="">{t("noEvent")}</option>{evs?.items.filter((e) => !prefill || e.currency === prefill.currency).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>
        <Field label={t("amount")} required error={errs.amount}>{(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} placeholder="10000.00" />}</Field>
        <Field label={t("currency")} required error={errs.currency}>{(p) => <Input {...p} value={v.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toLowerCase())} className="uppercase" />}</Field>
        <Field label={t("date")} required error={errs.paymentDate}>{(p) => <Input {...p} type="date" value={v.paymentDate} onChange={(e) => set("paymentDate", e.target.value)} />}</Field>
        <Field label={t("reference")}>{(p) => <Input {...p} value={v.bankReference} onChange={(e) => set("bankReference", e.target.value)} placeholder="BANK-2026-001" />}</Field>
        <Field label={t("method")}>{(p) => <Select {...p} value={v.method} onChange={(e) => set("method", e.target.value)}>{["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"].map((m) => <option key={m} value={m}>{t(`m.${m}`)}</option>)}</Select>}</Field>
        <Field label={t("status")}>{(p) => <Select {...p} value={v.status} onChange={(e) => set("status", e.target.value)}><option value="PAID">{t("st.PAID")}</option><option value="PENDING">{t("st.PENDING")}</option></Select>}</Field>
        <div className="sm:col-span-2"><Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field></div>
        <p className="text-xs text-muted sm:col-span-2">{t("modeNote", { mode: mode.toUpperCase() })}</p>
        {err && <div className="sm:col-span-2"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}

// ---------- link events to an organiser ----------
type Detected = { code: string; currency: string; transactions: number; gross: number; name: string; live: boolean };
type FreeEvent = { id: string; name: string; code: string; currency: string; organiserId: string | null };

/** Pick event codes detected in Stripe (creates the events) and/or existing unlinked events, and attach them to an organiser. */
export function LinkEventsDialog({ organiserId, onClose, onSaved }: { organiserId: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.link");
  const c = useTranslations("common");
  const toast = useToast();
  const { data: det } = useApi<{ items: Detected[] }>("/api/accounting/detected-codes");
  const { data: evs } = useApi<{ items: FreeEvent[] }>("/api/accounting/events?pageSize=200");
  const free = (evs?.items ?? []).filter((e) => !e.organiserId);
  const [pick, setPick] = useState<Record<string, { name: string } | undefined>>({});
  const [link, setLink] = useState<Record<string, boolean>>({});
  const [ag, setAg] = useState<AgreementValue>(emptyAgreement());
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const chosen = (det?.items ?? []).filter((d) => pick[`${d.code}|${d.currency}`]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const create = chosen.map((d) => ({ code: d.code, currency: d.currency, name: pick[`${d.code}|${d.currency}`]!.name || d.code }));
      const r = await api<{ created: number; linked: number; rematch: { matched: number } }>(`/api/accounting/organisers/${organiserId}/events`, { json: { create, link: Object.keys(link).filter((k) => link[k]), agreement: agreementPayload(ag, chosen[0]?.currency ?? "eur") } });
      toast("ok", t("done", { created: r.created, linked: r.linked, matched: r.rematch.matched })); onSaved(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const count = chosen.length + Object.values(link).filter(Boolean).length;
  return (
    <Modal open onClose={onClose} size="xl" title={t("title")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!count} onClick={submit}>{t("submit", { n: count })}</Button></>}>
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("detected")}</h3>
          <p className="text-xs text-muted">{t("detectedDesc")}</p>
          {!det ? null : !det.items.length ? <p className="text-sm text-muted">{t("noneDetected")}</p> : <ul className="divide-y divide-line rounded-xl border border-line">{det.items.map((d) => {
            const k = `${d.code}|${d.currency}`, on = !!pick[k];
            return <li key={k} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <Checkbox label={<code className="font-semibold">{d.code}</code>} checked={on} onChange={(e) => setPick({ ...pick, [k]: e.target.checked ? { name: d.name } : undefined })} />
              <Input aria-label={t("name")} value={pick[k]?.name ?? d.name} disabled={!on} onChange={(e) => setPick({ ...pick, [k]: { name: e.target.value } })} className="h-8 min-w-56 flex-1" />
              <span className="text-xs text-muted">{d.currency.toUpperCase()} · {t("txCount", { n: d.transactions })}{d.live ? "" : " · TEST"}</span>
            </li>;
          })}</ul>}
        </section>
        {free.length > 0 && <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("existing")}</h3>
          <ul className="divide-y divide-line rounded-xl border border-line">{free.map((e) => <li key={e.id} className="px-3 py-2"><Checkbox label={<><code className="me-2 text-xs">{e.code}</code>{e.name}</>} checked={!!link[e.id]} onChange={(x) => setLink({ ...link, [e.id]: x.target.checked })} /></li>)}</ul>
        </section>}
        {chosen.length > 0 && <AgreementFields v={ag} onChange={setAg} currency={chosen[0]!.currency} />}
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

/** Events page: create events from codes detected in Stripe, choosing an (optional) organiser per event. */
export function ImportEventsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.import");
  const c = useTranslations("common");
  const toast = useToast();
  const { data: det } = useApi<{ items: Detected[] }>("/api/accounting/detected-codes");
  const { data: orgs } = useApi<{ items: Org[] }>("/api/accounting/organisers?pageSize=200&active=true");
  const [rows, setRows] = useState<Record<string, { name: string; organiserId: string } | undefined>>({});
  const [ag, setAg] = useState<AgreementValue>(emptyAgreement());
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const items = det?.items ?? [];
  const chosen = items.filter((d) => rows[`${d.code}|${d.currency}`]);
  const set = (k: string, v: { name: string; organiserId: string } | undefined) => setRows((r) => ({ ...r, [k]: v }));
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const events = chosen.map((d) => { const r = rows[`${d.code}|${d.currency}`]!; return { code: d.code, currency: d.currency, name: r.name || d.code, organiserId: r.organiserId || null }; });
      const r = await api<{ created: number; rematch: { matched: number } }>("/api/accounting/events/import", { json: { events, agreement: agreementPayload(ag, chosen[0]?.currency ?? "eur") } });
      toast("ok", t("done", { created: r.created, matched: r.rematch.matched })); onSaved(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="xl" title={t("title")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!chosen.length} onClick={submit}>{t("submit", { n: chosen.length })}</Button></>}>
      <div className="space-y-5">
        {!det ? null : !items.length ? <p className="text-sm text-muted">{t("none")}</p> : <>
          <div className="flex justify-end"><Button size="sm" onClick={() => setRows(Object.fromEntries(items.map((d) => [`${d.code}|${d.currency}`, rows[`${d.code}|${d.currency}`] ?? { name: d.name, organiserId: "" }])))}>{t("selectAll")}</Button></div>
          <ul className="divide-y divide-line rounded-xl border border-line">{items.map((d) => {
            const k = `${d.code}|${d.currency}`, r = rows[k];
            return <li key={k} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <Checkbox label={<code className="font-semibold">{d.code}</code>} checked={!!r} onChange={(e) => set(k, e.target.checked ? { name: d.name, organiserId: "" } : undefined)} />
              <Input aria-label={t("name")} value={r?.name ?? d.name} disabled={!r} onChange={(e) => set(k, { ...r!, name: e.target.value })} className="h-8 min-w-56 flex-1" />
              <Select aria-label={t("organiser")} value={r?.organiserId ?? ""} disabled={!r} onChange={(e) => set(k, { ...r!, organiserId: e.target.value })} className="h-8 w-auto min-w-44"><option value="">{t("noOrganiser")}</option>{orgs?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
              <span className="text-xs text-muted">{d.currency.toUpperCase()} · {t("txCount", { n: d.transactions })}{d.live ? "" : " · TEST"}</span>
            </li>;
          })}</ul>
          <p className="text-xs text-muted">{t("organiserNote")}</p>
        </>}
        {chosen.length > 0 && <AgreementFields v={ag} onChange={setAg} currency={chosen[0]!.currency} />}
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}
