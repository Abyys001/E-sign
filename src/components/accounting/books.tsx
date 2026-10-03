"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { config, type IconDefinition } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRotateLeft, faBolt, faBuilding, faBuildingColumns, faBullhorn, faChair, faCoins, faCreditCard, faFileInvoice, faHandshake, faLaptopCode,
  faMasksTheater, faPercent, faPeopleGroup, faPlane, faPlus, faReceipt, faRotateLeft, faScaleBalanced, faTicket, faTrash, faTriangleExclamation, faUserTie,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";
import { formatMoney, parseMajor, toDecimalString } from "@/lib/money";

// Next injects the stylesheet above; stop Font Awesome adding its own <style> at runtime (avoids a flash of huge icons).
config.autoAddCss = false;

/** Font Awesome icon, decorative by default (the text next to it carries the meaning). */
export function Fa({ icon, className, label }: { icon: IconDefinition; className?: string; label?: string }) {
  return <FontAwesomeIcon icon={icon} className={className} aria-hidden={label ? undefined : true} aria-label={label} fixedWidth />;
}

const ACCOUNT_ICONS: Record<string, IconDefinition> = {
  rent: faBuilding, software: faLaptopCode, marketing: faBullhorn, travel: faPlane, professional_fees: faScaleBalanced, office: faChair, bank_charges: faBuildingColumns,
  utilities: faBolt, event_costs: faMasksTheater, other_expenses: faReceipt, wages: faUserTie, employer_payroll_costs: faPeopleGroup, ticket_sales: faTicket,
  bilit_commission: faPercent, other_revenue: faCoins, organiser_share: faHandshake, stripe_fees: faCreditCard, stripe_fee_recharges: faArrowRotateLeft,
  refunds: faRotateLeft, chargebacks: faTriangleExclamation,
};
export const accountIcon = (key: string | null | undefined) => (key && ACCOUNT_ICONS[key]) || faFileInvoice;

type FieldErrors = Record<string, string>;
const fieldErrors = (e: unknown): FieldErrors => (e instanceof ApiError && Array.isArray(e.details) ? Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])) : {});
const today = () => new Date().toISOString().slice(0, 10);
const tryMajor = (v: string, c: string) => { try { return v.trim() ? parseMajor(v, c) : 0; } catch { return null; } };

export type Account = { id: string; code: string; name: string; type: string; systemKey: string | null; active: boolean };
export function useExpenseAccounts() {
  const { data } = useApi<{ accounts: Account[] }>("/api/accounting/accounts");
  return (data?.accounts ?? []).filter((a) => a.type === "EXPENSE" && a.active && !["stripe_fees", "stripe_fee_recharges", "refunds", "chargebacks", "wages", "employer_payroll_costs"].includes(a.systemKey ?? ""));
}

// ---------- supplier invoice / expense ----------
export type BillRow = {
  id: string; kind: "BILL" | "EXPENSE"; supplierName: string; supplierVat: string | null; country: string | null; invoiceNumber: string | null; invoiceDate: string; dueDate: string | null; currency: string;
  netAmount: number; vatAmount: number; totalAmount: number; accountId: string; accountName: string; accountCode: string; eventId: string | null; eventName: string | null; description: string | null;
  paidFrom: string | null; status: string; paidDate: string | null; paymentReference: string | null; hasFile: boolean; fileName: string | null; overdue: boolean; voidReason: string | null; createdByName: string | null;
};
const VAT_RATES = ["0", "5", "7", "10", "19", "20", "21", "25"];

export function BillDialog({ kind, mode, bill, onClose, onSaved }: { kind: "BILL" | "EXPENSE"; mode: string; bill?: BillRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.books.doc");
  const c = useTranslations("common");
  const toast = useToast();
  const accounts = useExpenseAccounts();
  const { data: sup } = useApi<{ items: Array<{ name: string; vat: string | null; country: string | null; accountId: string; currency: string }> }>("/api/accounting/bills/suppliers");
  const { data: evs } = useApi<{ items: Array<{ id: string; name: string; code: string; currency: string }> }>("/api/accounting/events?pageSize=200");
  const [v, setV] = useState({
    supplierName: bill?.supplierName ?? "", supplierVat: bill?.supplierVat ?? "", country: bill?.country ?? "", invoiceNumber: bill?.invoiceNumber ?? "",
    invoiceDate: bill?.invoiceDate ?? today(), dueDate: bill?.dueDate ?? "", currency: bill?.currency ?? "gbp",
    net: bill ? toDecimalString(bill.netAmount, bill.currency) : "", vat: bill ? toDecimalString(bill.vatAmount, bill.currency) : "", rate: "",
    accountId: bill?.accountId ?? "", eventId: bill?.eventId ?? "", description: bill?.description ?? "", paidFrom: bill?.paidFrom ?? "BANK", alreadyPaid: false, paidDate: today(), paymentReference: "", reason: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [errs, setErrs] = useState<FieldErrors>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((o) => ({ ...o, [k]: x }));
  const net = tryMajor(v.net, v.currency), vat = tryMajor(v.vat, v.currency);
  const applyRate = (r: string) => { setV((o) => { const n = tryMajor(o.net, o.currency); return { ...o, rate: r, vat: n === null ? o.vat : toDecimalString(Math.round((n * Number(r)) / 100), o.currency) }; }); };
  const pickSupplier = (name: string) => {
    const s = sup?.items.find((x) => x.name.toLowerCase() === name.toLowerCase());
    setV((o) => ({ ...o, supplierName: name, ...(s && !bill ? { supplierVat: o.supplierVat || s.vat || "", country: o.country || s.country || "", accountId: o.accountId || s.accountId, currency: s.currency } : {}) }));
  };
  const submit = async () => {
    if (net === null || vat === null) { setErrs({ netAmount: t("invalidAmount") }); return; }
    setBusy(true); setErr(null); setErrs({});
    try {
      const base = { supplierName: v.supplierName, supplierVat: v.supplierVat || null, country: v.country || null, invoiceNumber: v.invoiceNumber || null, invoiceDate: v.invoiceDate, dueDate: kind === "BILL" ? v.dueDate || null : null,
        netAmount: net, vatAmount: vat, accountId: v.accountId, eventId: v.eventId || null, description: v.description || null, paidFrom: kind === "EXPENSE" ? v.paidFrom : undefined };
      const row = bill ? await api<{ id: string }>(`/api/accounting/bills/${bill.id}`, { method: "PATCH", json: { ...base, reason: v.reason } })
        : await api<{ id: string }>("/api/accounting/bills", { json: { ...base, mode, kind, currency: v.currency, paidFrom: kind === "EXPENSE" ? v.paidFrom : v.alreadyPaid ? v.paidFrom : null, paidDate: kind === "BILL" && v.alreadyPaid ? v.paidDate : null, paymentReference: v.paymentReference || null } });
      if (file) { const form = new FormData(); form.append("file", file); try { await api(`/api/accounting/bills/${row.id}/file`, { form }); } catch (e) { toast("error", `${t("fileFailed")}: ${errMsg(e)}`); } }
      toast("ok", bill ? t("updated") : kind === "BILL" ? t("billAdded") : t("expenseAdded")); onSaved(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const evOptions = (evs?.items ?? []).filter((e) => e.currency === v.currency);
  return (
    <Modal open onClose={onClose} size="xl" title={bill ? t("edit") : kind === "BILL" ? t("newBill") : t("newExpense")} description={kind === "BILL" ? t("billDesc") : t("expenseDesc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.supplierName || !v.accountId || !v.net || (!!bill && v.reason.trim().length < 3)} onClick={submit}>{c("save")}</Button></>}>
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid content-start gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label={kind === "BILL" ? t("supplier") : t("payee")} required error={errs.supplierName}>{(p) => <><Input {...p} list="bk-suppliers" value={v.supplierName} onChange={(e) => pickSupplier(e.target.value)} autoComplete="off" /><datalist id="bk-suppliers">{sup?.items.map((s) => <option key={s.name} value={s.name} />)}</datalist></>}</Field></div>
          <Field label={t("invoiceNumber")}>{(p) => <Input {...p} value={v.invoiceNumber} onChange={(e) => set("invoiceNumber", e.target.value)} />}</Field>
          <Field label={t("date")} required error={errs.invoiceDate}>{(p) => <Input {...p} type="date" value={v.invoiceDate} onChange={(e) => set("invoiceDate", e.target.value)} />}</Field>
          <Field label={t("category")} required error={errs.accountId}>{(p) => <Select {...p} value={v.accountId} onChange={(e) => set("accountId", e.target.value)}><option value="">{t("chooseCategory")}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
          <Field label={t("currency")} required error={errs.currency}>{(p) => <Input {...p} value={v.currency} maxLength={3} disabled={!!bill} onChange={(e) => set("currency", e.target.value.toLowerCase())} className="uppercase" />}</Field>
          <Field label={t("net")} required error={errs.netAmount}>{(p) => <Input {...p} inputMode="decimal" value={v.net} onChange={(e) => { set("net", e.target.value); if (v.rate) { const n = tryMajor(e.target.value, v.currency); if (n !== null) set("vat", toDecimalString(Math.round((n * Number(v.rate)) / 100), v.currency)); } }} />}</Field>
          <Field label={t("vat")} error={errs.vatAmount}>{(p) => <Input {...p} inputMode="decimal" value={v.vat} onChange={(e) => { set("vat", e.target.value); set("rate", ""); }} />}</Field>
          <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2"><span className="me-1 text-xs text-muted">{t("vatRate")}</span>{VAT_RATES.map((r) => <button key={r} type="button" onClick={() => applyRate(r)} className={`rounded-full border px-2.5 py-0.5 text-xs ${v.rate === r ? "border-accent bg-accent-soft font-medium" : "border-line-strong text-muted hover:text-fg"}`}>{r} %</button>)}</div>
          {kind === "BILL" ? <Field label={t("dueDate")}>{(p) => <Input {...p} type="date" value={v.dueDate} onChange={(e) => set("dueDate", e.target.value)} />}</Field>
            : <Field label={t("paidFrom")}>{(p) => <Select {...p} value={v.paidFrom} onChange={(e) => set("paidFrom", e.target.value)}>{["BANK", "CARD", "CASH", "EMPLOYEE"].map((k) => <option key={k} value={k}>{t(`from.${k}`)}</option>)}</Select>}</Field>}
          <Field label={t("event")} hint={t("eventHint")}>{(p) => <Select {...p} value={v.eventId} onChange={(e) => set("eventId", e.target.value)}><option value="">{t("noEvent")}</option>{evOptions.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>
          <Field label={t("supplierVat")}>{(p) => <Input {...p} value={v.supplierVat} onChange={(e) => set("supplierVat", e.target.value)} />}</Field>
          <Field label={t("country")} hint="GB, DE, FR…">{(p) => <Input {...p} value={v.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} className="uppercase" />}</Field>
          <div className="sm:col-span-2"><Field label={t("description")}>{(p) => <Textarea {...p} value={v.description} onChange={(e) => set("description", e.target.value)} className="min-h-16" />}</Field></div>
          {kind === "BILL" && !bill && <div className="space-y-3 sm:col-span-2"><Checkbox label={t("alreadyPaid")} checked={v.alreadyPaid} onChange={(e) => set("alreadyPaid", e.target.checked)} />
            {v.alreadyPaid && <div className="grid gap-3 sm:grid-cols-3"><Field label={t("paidDate")}>{(p) => <Input {...p} type="date" value={v.paidDate} onChange={(e) => set("paidDate", e.target.value)} />}</Field>
              <Field label={t("paidFrom")}>{(p) => <Select {...p} value={v.paidFrom} onChange={(e) => set("paidFrom", e.target.value)}>{["BANK", "CARD", "CASH", "EMPLOYEE"].map((k) => <option key={k} value={k}>{t(`from.${k}`)}</option>)}</Select>}</Field>
              <Field label={t("paymentReference")}>{(p) => <Input {...p} value={v.paymentReference} onChange={(e) => set("paymentReference", e.target.value)} />}</Field></div>}</div>}
          {bill && <div className="sm:col-span-2"><Field label={t("reason")} required error={errs.reason}>{(p) => <Input {...p} value={v.reason} onChange={(e) => set("reason", e.target.value)} />}</Field></div>}
        </div>
        <div className="space-y-4">
          <label className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong p-5 text-center text-sm hover:border-accent">
            <Fa icon={faFileInvoice} className="text-3xl text-muted" />
            <span className="font-medium">{file ? file.name : bill?.hasFile ? t("replaceFile") : t("uploadFile")}</span>
            <span className="text-xs text-muted">{bill?.fileName && !file ? bill.fileName : t("fileHint")}</span>
            <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <dl className="rounded-xl border border-line bg-surface-2/50 p-4 text-sm">
            <div className="flex justify-between py-1"><dt className="text-muted">{t("net")}</dt><dd className="tabular-nums">{net === null ? "—" : formatMoney(net, v.currency || "gbp")}</dd></div>
            <div className="flex justify-between py-1"><dt className="text-muted">{t("vat")}</dt><dd className="tabular-nums">{vat === null ? "—" : formatMoney(vat, v.currency || "gbp")}</dd></div>
            <div className="mt-1 flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>{t("total")}</dt><dd className="tabular-nums">{net === null || vat === null ? "—" : formatMoney(net + vat, v.currency || "gbp")}</dd></div>
          </dl>
          {err && <Callout tone="warn">{err}</Callout>}
        </div>
      </div>
    </Modal>
  );
}

export function PayBillDialog({ bill, onClose, onSaved }: { bill: BillRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.books.doc");
  const c = useTranslations("common");
  const toast = useToast();
  const [v, setV] = useState({ paidDate: today(), paidFrom: "BANK", paymentReference: "" });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); setErr(null); try { await api(`/api/accounting/bills/${bill.id}/pay`, { json: { ...v, paymentReference: v.paymentReference || null } }); toast("ok", t("markedPaid")); onSaved(); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title={t("payTitle")} description={`${bill.supplierName} · ${formatMoney(bill.totalAmount, bill.currency)}`}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} onClick={submit}>{t("markPaid")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("paidDate")}>{(p) => <Input {...p} type="date" value={v.paidDate} onChange={(e) => setV({ ...v, paidDate: e.target.value })} />}</Field>
        <Field label={t("paidFrom")}>{(p) => <Select {...p} value={v.paidFrom} onChange={(e) => setV({ ...v, paidFrom: e.target.value })}>{["BANK", "CARD", "CASH", "EMPLOYEE"].map((k) => <option key={k} value={k}>{t(`from.${k}`)}</option>)}</Select>}</Field>
        <Field label={t("paymentReference")}>{(p) => <Input {...p} value={v.paymentReference} onChange={(e) => setV({ ...v, paymentReference: e.target.value })} />}</Field>
        {err && <div className="sm:col-span-3"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}

// ---------- employees ----------
export type EmployeeRow = { id: string; name: string; email: string | null; jobTitle: string | null; employeeRef: string | null; country: string; currency: string; taxId: string | null; socialSecurityNo: string | null; address: string | null; startDate: string | null; endDate: string | null; payFrequency: string; defaultGross: number | null; active: boolean; notes: string | null; hasBankDetails: boolean; bankHint: string | null; ytdGross: number; lastPayDate: string | null };

export function EmployeeDialog({ employee, onClose, onSaved }: { employee?: EmployeeRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.books.emp");
  const c = useTranslations("common");
  const toast = useToast();
  const e0 = employee;
  const [v, setV] = useState({ name: e0?.name ?? "", email: e0?.email ?? "", jobTitle: e0?.jobTitle ?? "", employeeRef: e0?.employeeRef ?? "", country: e0?.country ?? "GB", currency: e0?.currency ?? "gbp", taxId: e0?.taxId ?? "", socialSecurityNo: e0?.socialSecurityNo ?? "", address: e0?.address ?? "", startDate: e0?.startDate ?? "", endDate: e0?.endDate ?? "", payFrequency: e0?.payFrequency ?? "MONTHLY", defaultGross: e0?.defaultGross != null ? toDecimalString(e0.defaultGross, e0.currency) : "", active: e0?.active ?? true, notes: e0?.notes ?? "" });
  const [editBank, setEditBank] = useState(!e0); const [bank, setBank] = useState({ accountHolder: "", iban: "", bic: "", accountNumber: "", sortCode: "", bankName: "" });
  const [errs, setErrs] = useState<FieldErrors>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((o) => ({ ...o, [k]: x }));
  const labels = v.country === "GB" ? [t("taxCodeGB"), t("niGB")] : v.country === "DE" ? [t("taxIdDE"), t("svDE")] : [t("taxId"), t("social")];
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try {
      const gross = v.defaultGross ? tryMajor(v.defaultGross, v.currency) : null;
      const anyBank = Object.values(bank).some((x) => x.trim());
      const payload = { ...v, email: v.email || null, startDate: v.startDate || null, endDate: v.endDate || null, defaultGross: gross, ...(editBank ? { bankDetails: anyBank ? bank : null } : {}) };
      if (employee) await api(`/api/accounting/employees/${employee.id}`, { method: "PATCH", json: payload }); else await api("/api/accounting/employees", { json: payload });
      toast("ok", c("saved")); onSaved(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const I = (k: keyof typeof v, label: string, o: { type?: string; upper?: boolean; max?: number; hint?: string } = {}) => <Field label={label} hint={o.hint} error={errs[k]}>{(p) => <Input {...p} type={o.type} maxLength={o.max} value={String(v[k])} onChange={(e) => set(k, (o.upper ? e.target.value.toUpperCase() : e.target.value) as never)} className={o.upper ? "uppercase" : undefined} />}</Field>;
  return (
    <Modal open onClose={onClose} size="xl" title={employee ? t("edit") : t("add")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name || !v.country || !v.currency} onClick={submit}>{c("save")}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {I("name", t("name"))}{I("jobTitle", t("jobTitle"))}{I("employeeRef", t("ref"))}
        {I("email", t("email"), { type: "email" })}{I("country", t("country"), { upper: true, max: 2, hint: "GB, DE, FR…" })}
        <Field label={t("currency")} error={errs.currency}>{(p) => <Input {...p} value={v.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toLowerCase())} className="uppercase" />}</Field>
        {I("taxId", labels[0]!)}{I("socialSecurityNo", labels[1]!)}
        <Field label={t("frequency")}>{(p) => <Select {...p} value={v.payFrequency} onChange={(e) => set("payFrequency", e.target.value)}>{["MONTHLY", "FOUR_WEEKLY", "FORTNIGHTLY", "WEEKLY"].map((f) => <option key={f} value={f}>{t(`freq.${f}`)}</option>)}</Select>}</Field>
        {I("defaultGross", `${t("defaultGross")} (${v.currency.toUpperCase()})`, { hint: t("defaultGrossHint") })}{I("startDate", t("start"), { type: "date" })}{I("endDate", t("end"), { type: "date" })}
        <div className="sm:col-span-2 lg:col-span-3"><Field label={t("address")}>{(p) => <Textarea {...p} value={v.address} onChange={(e) => set("address", e.target.value)} className="min-h-16" />}</Field></div>
        <fieldset className="space-y-3 rounded-xl border border-line p-4 sm:col-span-2 lg:col-span-3"><legend className="px-1 text-sm font-semibold">{t("bank")}</legend>
          {!editBank ? <Button size="sm" onClick={() => setEditBank(true)}>{employee?.hasBankDetails ? t("replaceBank") : t("addBank")}</Button> : <div className="grid gap-3 sm:grid-cols-3">
            {(["accountHolder", "bankName", "iban", "bic", "accountNumber", "sortCode"] as const).map((k) => <Field key={k} label={t(`b.${k}`)}>{(p) => <Input {...p} autoComplete="off" value={bank[k]} onChange={(e) => setBank({ ...bank, [k]: e.target.value })} />}</Field>)}</div>}
        </fieldset>
        <div className="sm:col-span-2 lg:col-span-3"><Field label={t("notes")}>{(p) => <Textarea {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-16" />}</Field></div>
        <Checkbox label={t("active")} checked={v.active} onChange={(e) => set("active", e.target.checked)} />
        {err && <div className="sm:col-span-2 lg:col-span-3"><Callout tone="warn">{err}</Callout></div>}
      </div>
    </Modal>
  );
}

// ---------- payslip ----------
type L = { label: string; amount: string; type?: string };
export type PayslipRow = { id: string; employeeId: string; employeeName: string; employeeRef: string | null; country: string; number: string | null; periodStart: string; periodEnd: string; payDate: string; currency: string; earnings: Array<{ label: string; amount: number }>; deductions: Array<{ label: string; type: string; amount: number }>; employerCosts: Array<{ label: string; amount: number }>; grossPay: number; totalDeductions: number; netPay: number; employerTotal: number; notes: string | null; status: string; paidDate: string | null; paymentReference: string | null; voidReason: string | null; hasPdf: boolean };
const DED_TYPES = ["TAX", "SOCIAL", "PENSION", "STUDENT_LOAN", "OTHER"];

function monthBounds() { const d = new Date(); const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)] as const; }

function Lines({ title, rows, setRows, typed }: { title: string; rows: L[]; setRows: (r: L[]) => void; typed?: boolean }) {
  const t = useTranslations("accounting.books.ps");
  return (
    <fieldset className="space-y-2"><legend className="mb-1 text-sm font-semibold">{title}</legend>
      {rows.map((r, i) => <div key={i} className="flex flex-wrap items-center gap-2">
        {typed && <Select aria-label={t("type")} value={r.type ?? "OTHER"} onChange={(x) => setRows(rows.map((y, j) => (j === i ? { ...y, type: x.target.value } : y)))} className="h-9 w-36">{DED_TYPES.map((k) => <option key={k} value={k}>{t(`dt.${k}`)}</option>)}</Select>}
        <Input aria-label={t("label")} value={r.label} onChange={(x) => setRows(rows.map((y, j) => (j === i ? { ...y, label: x.target.value } : y)))} className="h-9 min-w-40 flex-1" />
        <Input aria-label={t("amount")} inputMode="decimal" value={r.amount} onChange={(x) => setRows(rows.map((y, j) => (j === i ? { ...y, amount: x.target.value } : y)))} className="h-9 w-32 text-end" placeholder="0.00" />
        <Button size="icon" variant="ghost" aria-label={t("removeLine")} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Fa icon={faTrash} className="text-sm" /></Button>
      </div>)}
      <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { label: "", amount: "", ...(typed ? { type: "OTHER" } : {}) }])}><Fa icon={faPlus} className="text-xs" />{t("addLine")}</Button>
    </fieldset>
    );
}

export function PayslipDialog({ mode, employees, payslip, onClose, onSaved }: { mode: string; employees: EmployeeRow[]; payslip?: PayslipRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.books.ps");
  const c = useTranslations("common");
  const toast = useToast();
  const [ms, me] = monthBounds();
  const active = employees.filter((e) => e.active || e.id === payslip?.employeeId);
  const [emp, setEmp] = useState(payslip?.employeeId ?? active[0]?.id ?? "");
  const e = employees.find((x) => x.id === emp);
  const cur = payslip?.currency ?? e?.currency ?? "gbp";
  const toL = (a: Array<{ label: string; amount: number; type?: string }>) => a.map((x) => ({ label: x.label, amount: toDecimalString(x.amount, cur), type: x.type }));
  const dl = (country: string | undefined) => country === "GB" ? { TAX: "Income tax (PAYE)", SOCIAL: "National Insurance", PENSION: "Pension" } : country === "DE" ? { TAX: "Lohnsteuer", SOCIAL: "Sozialversicherung", PENSION: "Rentenversicherung" } : { TAX: "Income tax", SOCIAL: "Social security", PENSION: "Pension" };
  const defaults = (x: EmployeeRow | undefined): { earn: L[]; ded: L[]; er: L[] } => { const l = dl(x?.country); return { earn: [{ label: t("basic"), amount: x?.defaultGross != null ? toDecimalString(x.defaultGross, x.currency) : "" }], ded: [{ label: l.TAX, type: "TAX", amount: "" }, { label: l.SOCIAL, type: "SOCIAL", amount: "" }, { label: l.PENSION, type: "PENSION", amount: "" }], er: [] }; };
  const init = payslip ? { earn: toL(payslip.earnings), ded: toL(payslip.deductions), er: toL(payslip.employerCosts) } : defaults(e);
  const [earn, setEarn] = useState<L[]>(init.earn); const [ded, setDed] = useState<L[]>(init.ded); const [er, setEr] = useState<L[]>(init.er);
  const [dates, setDates] = useState({ periodStart: payslip?.periodStart ?? ms, periodEnd: payslip?.periodEnd ?? me, payDate: payslip?.payDate ?? me });
  const [notes, setNotes] = useState(payslip?.notes ?? "");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const parse = (l: L[]) => l.filter((x) => x.label.trim() && x.amount.trim()).map((x) => ({ label: x.label.trim(), amount: tryMajor(x.amount, cur), ...(x.type ? { type: x.type } : {}) }));
  const pe = parse(earn), pd = parse(ded), pr = parse(er);
  const bad = [...pe, ...pd, ...pr].some((x) => x.amount === null);
  const gross = pe.reduce((s, x) => s + (x.amount ?? 0), 0), deductions = pd.reduce((s, x) => s + (x.amount ?? 0), 0), employer = pr.reduce((s, x) => s + (x.amount ?? 0), 0);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...dates, earnings: pe, deductions: pd, employerCosts: pr, notes: notes || null };
      if (payslip) await api(`/api/accounting/payslips/${payslip.id}`, { method: "PATCH", json: body }); else await api("/api/accounting/payslips", { json: { ...body, mode, employeeId: emp } });
      toast("ok", t("saved")); onSaved(); onClose();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const m = (v: number) => formatMoney(v, cur);
  return (
    <Modal open onClose={onClose} size="xl" title={payslip ? t("editDraft") : t("new")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!emp || bad || gross <= 0 || deductions > gross} onClick={submit}>{t("saveDraft")}</Button></>}>
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-4"><Field label={t("employee")} required>{(p) => <Select {...p} value={emp} disabled={!!payslip} onChange={(x) => { setEmp(x.target.value); const ne = employees.find((y) => y.id === x.target.value); const d = defaults(ne); setEarn(d.earn); setDed(d.ded); setEr(d.er); }}>{active.map((x) => <option key={x.id} value={x.id}>{x.name}{x.employeeRef ? ` (${x.employeeRef})` : ""} · {x.currency.toUpperCase()}</option>)}</Select>}</Field></div>
            <Field label={t("periodStart")}>{(p) => <Input {...p} type="date" value={dates.periodStart} onChange={(x) => setDates({ ...dates, periodStart: x.target.value })} />}</Field>
            <Field label={t("periodEnd")}>{(p) => <Input {...p} type="date" value={dates.periodEnd} onChange={(x) => setDates({ ...dates, periodEnd: x.target.value })} />}</Field>
            <Field label={t("payDate")}>{(p) => <Input {...p} type="date" value={dates.payDate} onChange={(x) => setDates({ ...dates, payDate: x.target.value })} />}</Field>
          </div>
          <Lines title={t("earnings")} rows={earn} setRows={setEarn} />
          <Lines title={t("deductions")} rows={ded} setRows={setDed} typed />
          <Lines title={t("employerCosts")} rows={er} setRows={setEr} />
          <Field label={t("notes")} hint={t("notesHint")}>{(p) => <Textarea {...p} value={notes} onChange={(x) => setNotes(x.target.value)} className="min-h-16" />}</Field>
        </div>
        <aside className="h-fit space-y-3 rounded-xl border border-line bg-surface-2/50 p-4 text-sm lg:sticky lg:top-0">
          <p className="font-semibold">{e?.name ?? "—"}</p>
          <dl className="space-y-1.5">
            <div className="flex justify-between"><dt className="text-muted">{t("gross")}</dt><dd className="tabular-nums">{m(gross)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">{t("totalDeductions")}</dt><dd className="tabular-nums">−{m(deductions)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold"><dt>{t("net")}</dt><dd className={`tabular-nums ${gross - deductions < 0 ? "text-fin-neg" : "text-fin-pos"}`}>{m(gross - deductions)}</dd></div>
            <div className="flex justify-between pt-2 text-xs"><dt className="text-muted">{t("employerTotal")}</dt><dd className="tabular-nums">{m(employer)}</dd></div>
            <div className="flex justify-between text-xs"><dt className="text-muted">{t("costToCompany")}</dt><dd className="font-medium tabular-nums">{m(gross + employer)}</dd></div>
          </dl>
          {deductions > gross && <Callout tone="warn">{t("tooMuch")}</Callout>}
          <p className="text-xs text-muted">{t("manualNote")}</p>
          {err && <Callout tone="warn">{err}</Callout>}
        </aside>
      </div>
    </Modal>
  );
}
