"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, Bot, CircleAlert, Info, Sparkles } from "lucide-react";
import { Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";
import { parseMajor, toDecimalString } from "@/lib/money";

type Issue = { level: "error" | "warn" | "info"; text: string };
type Proposal = {
  organiserId: string | null; organiserName: string | null; organiserGuess: string | null; eventId: string | null; eventLabel: string | null;
  amount: number | null; currency: string; paymentDate: string; method: string; status: "PAID" | "PENDING"; bankReference: string | null; notes: string | null;
  confidence: "high" | "medium" | "low"; reasoning: string | null;
  balance: { due: number; paid: number; remaining: number; after: number | null; scope: "organiser" | "event" } | null;
  duplicates: Array<{ id: string }>; issues: Issue[];
};
type Result = { understanding: string; accountantNote: string | null; warnings: string[]; questions: string[]; proposals: Proposal[]; model: string };
type Row = { include: boolean; dupOk: boolean; done: boolean; organiserId: string; eventId: string; amount: string; currency: string; paymentDate: string; method: string; status: string; bankReference: string; notes: string; p: Proposal };

const toRow = (p: Proposal): Row => ({ include: true, dupOk: false, done: false, organiserId: p.organiserId ?? "", eventId: p.eventId ?? "", amount: p.amount != null ? toDecimalString(p.amount, p.currency) : "", currency: p.currency, paymentDate: p.paymentDate, method: p.method, status: p.status, bankReference: p.bankReference ?? "", notes: p.notes ?? "", p });

/** AI payment agent: paste a bank/Wise confirmation or type an instruction; the AI bookkeeper proposes checked organiser payments to confirm. */
export function PaymentAgentDialog({ open, onClose, onSaved, organiserId, initialText, autoRun, forceMode }: { open: boolean; onClose: () => void; onSaved: () => void; organiserId?: string; initialText?: string; autoRun?: boolean; forceMode?: "live" | "test" }) {
  const t = useTranslations("accounting.payagent");
  const tp = useTranslations("accounting.payments");
  const c = useTranslations("common");
  const toast = useToast();
  const m = useMode();
  const mode = forceMode ?? m.mode;
  const q = (u: string) => (forceMode ? `${u}${u.includes("?") ? "&" : "?"}mode=${forceMode}` : m.q(u));
  const ai = useApi<{ enabled: boolean; hasKey: boolean }>(open ? "/api/accounting/settings/ai" : null);
  const { data: orgs } = useApi<{ items: Array<{ id: string; name: string }> }>(open ? "/api/accounting/organisers?pageSize=200" : null);
  const { data: evs } = useApi<{ items: Array<{ id: string; name: string; code: string; currency: string; organiserId: string | null }> }>(open ? "/api/accounting/events?pageSize=200" : null);
  const [text, setText] = useState(initialText ?? ""); const [busy, setBusy] = useState(false); const [saving, setSaving] = useState(false);
  const [res, setRes] = useState<Result | null>(null); const [rows, setRows] = useState<Row[]>([]); const [err, setErr] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const analyse = async () => {
    setBusy(true); setErr(null); setRes(null); setRows([]);
    try {
      const r = await api<Result>(q("/api/accounting/organiser-payments/agent"), { json: { text, organiserId: organiserId ?? null } });
      setRes(r); setRows(r.proposals.map(toRow));
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  // Opened with prepared text (e.g. from the Wise feed): analyse straight away, once.
  const [started, setStarted] = useState(false);
  useEffect(() => { if (open && autoRun && initialText && !started && ai.data?.enabled && ai.data.hasKey) { setStarted(true); void analyse(); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = (r: Row) => !r.organiserId || !r.amount || !r.paymentDate || !/^[a-z]{3}$/.test(r.currency) || (r.p.duplicates.length > 0 && !r.dupOk);
  const chosen = rows.filter((r) => r.include && !r.done);
  const record = async () => {
    setSaving(true); setErr(null);
    let ok = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!r.include || r.done || blocked(r)) continue;
      try {
        const amount = parseMajor(r.amount, r.currency);
        await api("/api/accounting/organiser-payments", { json: { mode, organiserId: r.organiserId, eventId: r.eventId || null, amount, currency: r.currency, paymentDate: r.paymentDate, bankReference: r.bankReference || null, method: r.method, notes: r.notes || null, status: r.status } });
        set(i, { done: true }); ok++;
      } catch (e) { setErr(`${t("row", { n: i + 1 })}: ${errMsg(e)}`); break; }
    }
    setSaving(false);
    if (ok) { toast("ok", t("recorded", { n: ok })); onSaved(); }
    if (ok && ok === chosen.length) onClose();
  };
  const notReady = ai.data && (!ai.data.enabled || !ai.data.hasKey);

  return (
    <Modal open={open} onClose={onClose} size="xl" title={t("title")} description={t("desc")}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button>
        {res ? <Button variant="primary" loading={saving} disabled={!chosen.length || chosen.some(blocked)} onClick={record}>{t("record", { n: chosen.length })}</Button>
          : <Button variant="primary" loading={busy} disabled={text.trim().length < 3 || !!notReady} onClick={analyse}><Sparkles className="size-4" aria-hidden />{t("analyse")}</Button>}</>}>
      <div className="space-y-4">
        {notReady && <Callout tone="warn" title={t("notReady")}><Link href="/accounting/settings" className="underline">{t("openSettings")}</Link></Callout>}
        {!res ? <>
          <Field label={t("textLabel")} hint={t("textHint")}>{(p) => <Textarea {...p} value={text} onChange={(e) => setText(e.target.value)} className="min-h-40 font-mono text-sm" placeholder={t("placeholder")} autoFocus />}</Field>
          <p className="text-xs text-muted">{t("privacy")} · {tp("modeNote", { mode: mode.toUpperCase() })}</p>
        </> : <>
          <div className="flex gap-3 rounded-xl border border-line-strong bg-surface-2 p-3.5 text-sm">
            <Bot className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="min-w-0 space-y-1.5"><p>{res.understanding}</p>{res.accountantNote && <p className="text-muted">{res.accountantNote}</p>}</div>
          </div>
          {(res.warnings.length > 0 || res.questions.length > 0) && <Callout tone="warn" title={t("checks")}>
            <ul className="list-disc space-y-0.5 ps-5">{res.warnings.map((w, i) => <li key={`w${i}`}>{w}</li>)}{res.questions.map((w, i) => <li key={`q${i}`}><strong>{t("question")}</strong> {w}</li>)}</ul>
          </Callout>}
          {!rows.length && <Callout title={t("none")} />}
          {rows.map((r, i) => {
            const orgEvents = (evs?.items ?? []).filter((e) => e.organiserId === r.organiserId && e.currency === r.currency);
            return (
              <div key={i} className={`rounded-xl border p-4 ${r.done ? "border-accent bg-accent-soft" : "border-line"}`}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <Checkbox label={<span className="font-medium">{t("row", { n: i + 1 })}{r.done && ` — ${t("done")}`}</span>} checked={r.include} disabled={r.done} onChange={(e) => set(i, { include: e.target.checked })} />
                  <span className="text-xs text-muted">{t("confidence")}: {t(`conf.${r.p.confidence}`)}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={tp("organiser")} required>{(p) => <Select {...p} value={r.organiserId} disabled={r.done} onChange={(e) => set(i, { organiserId: e.target.value, eventId: "" })}><option value="">{r.p.organiserGuess ? `— ${r.p.organiserGuess}? —` : "—"}</option>{orgs?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
                  <Field label={tp("event")}>{(p) => <Select {...p} value={r.eventId} disabled={r.done} onChange={(e) => set(i, { eventId: e.target.value })}><option value="">{tp("noEvent")}</option>{orgEvents.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</Select>}</Field>
                  <Field label={tp("date")} required>{(p) => <Input {...p} type="date" value={r.paymentDate} disabled={r.done} onChange={(e) => set(i, { paymentDate: e.target.value })} />}</Field>
                  <Field label={tp("amount")} required>{(p) => <Input {...p} inputMode="decimal" value={r.amount} disabled={r.done} onChange={(e) => set(i, { amount: e.target.value })} />}</Field>
                  <Field label={tp("currency")} required>{(p) => <Input {...p} value={r.currency} maxLength={3} disabled={r.done} onChange={(e) => set(i, { currency: e.target.value.toLowerCase(), eventId: "" })} className="uppercase" />}</Field>
                  <Field label={tp("reference")}>{(p) => <Input {...p} value={r.bankReference} disabled={r.done} onChange={(e) => set(i, { bankReference: e.target.value })} />}</Field>
                  <Field label={tp("method")}>{(p) => <Select {...p} value={r.method} disabled={r.done} onChange={(e) => set(i, { method: e.target.value })}>{["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"].map((m) => <option key={m} value={m}>{tp(`m.${m}`)}</option>)}</Select>}</Field>
                  <Field label={tp("status")}>{(p) => <Select {...p} value={r.status} disabled={r.done} onChange={(e) => set(i, { status: e.target.value })}><option value="PAID">{tp("st.PAID")}</option><option value="PENDING">{tp("st.PENDING")}</option></Select>}</Field>
                  <div className="sm:col-span-3"><Field label={tp("notes")}>{(p) => <Textarea {...p} value={r.notes} disabled={r.done} onChange={(e) => set(i, { notes: e.target.value })} className="min-h-14" />}</Field></div>
                </div>
                {r.p.balance && r.organiserId === r.p.organiserId && r.currency === r.p.currency && <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span className="text-muted">{t(r.p.balance.scope === "event" ? "balEvent" : "balOrganiser")}</span>
                  <span>{t("due")} <Money v={r.p.balance.due} c={r.currency} /></span><span>{t("paid")} <Money v={r.p.balance.paid} c={r.currency} /></span>
                  <span>{t("remaining")} <Money v={r.p.balance.remaining} c={r.currency} strong /></span>
                  {r.p.balance.after != null && <span>{t("after")} <Money v={r.p.balance.after} c={r.currency} strong /></span>}
                </p>}
                {r.p.issues.length > 0 && <ul className="mt-3 space-y-1 text-sm">{r.p.issues.map((x, k) => <li key={k} className="flex gap-2">
                  {x.level === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> : x.level === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
                  <span className={x.level === "error" ? "font-medium" : ""}>{x.text}</span></li>)}</ul>}
                {r.p.duplicates.length > 0 && !r.done && <Checkbox className="mt-2" label={t("dupOk")} checked={r.dupOk} onChange={(e) => set(i, { dupOk: e.target.checked })} />}
                {r.p.reasoning && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">{t("why")}</summary><p className="mt-1">{r.p.reasoning}</p></details>}
              </div>
            );
          })}
          <div className="flex justify-between text-xs text-muted"><button type="button" className="underline" onClick={() => { setRes(null); setRows([]); }}>{t("again")}</button><span>{t("model", { model: res.model })}</span></div>
        </>}
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}
