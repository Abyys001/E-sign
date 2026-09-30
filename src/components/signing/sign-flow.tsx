"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, ArrowDownToLine, BadgeCheck, CheckCircle2, ChevronRight, Clock, FileCheck2, ListChecks, Loader2, Lock, PenLine, ShieldCheck, Type } from "lucide-react";
import { LocaleSwitch } from "@/components/app/locale-switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Logo } from "@/components/ui/logo";
import { Modal } from "@/components/ui/modal";
import { PdfViewer } from "@/components/ui/pdf-viewer";
import { ApiError, api, errMsg, fmtDate } from "@/lib/api";
import { isWinAnsi, renderTextPng } from "./canvas";
import { SignatureModal, type SigValue } from "./signature-modal";
import { VerifyStep } from "./verify-step";

type FieldDef = { key: string; type: string; label: string; page: number; x: number; y: number; w: number; h: number; required: boolean; options: string[]; validation: Record<string, unknown>; defaultValue: string | null; filled: boolean };
type SignView = {
  state: "sign"; contract: { name: string; reference: string; message: string | null; expiresAt: string; senderName: string; pages: number; pageGeometry: Array<{ box: number[] }>; status: string };
  branding: { orgName: string; supportEmail: string; tagline: string | null; logoUrl: string | null };
  recipient: { name: string; email: string; role: string }; fields: FieldDef[];
  filledByOthers: Array<{ key: string; type: string; page: number; x: number; y: number; w: number; h: number; text: string | null }>;
  consent: { required: boolean; text: string }; methods: { typed: boolean; drawn: boolean; uploaded: boolean };
  progress: { signed: number; total: number }; otherSigners: Array<{ name: string; status: "signed" | "you" | "waiting" | "later" }>;
};
type Open = SignView | { state: "verify"; method: "EMAIL_OTP" | "SMS_OTP" | "PASSCODE" | "ACCOUNT"; contract: { name: string; reference: string }; recipient: { name: string; emailHint: string }; replaced: boolean } | { state: "signed"; contract: { name: string; reference: string; status: string }; canDownload: boolean };

type Val = { kind: "sig"; sig: SigValue } | { kind: "text"; text: string } | { kind: "bool"; checked: boolean } | { kind: "attachment"; objectId: string; bytes: number; mime: string; name: string };
const SIG = new Set(["signature", "initials"]);
const TEXTUAL = new Set(["text", "long_text", "email", "phone", "date", "datetime", "radio", "dropdown", "number", "currency", "company", "job_title"]);

export function SignFlow({ token }: { token: string }) {
  const t = useTranslations("signing");
  const locale = useLocale();
  const [open, setOpen] = useState<Open | null>(null);
  const [fatal, setFatal] = useState<{ kind: string; message: string } | null>(null);
  const [done, setDone] = useState<{ complete: boolean; next: string[] } | "declined" | null>(null);
  const load = useCallback(async () => {
    try { setOpen(await api<Open>(`/api/sign/${token}?locale=${locale}`)); setFatal(null); }
    catch (e) { setFatal(e instanceof ApiError ? { kind: e.code, message: e.message } : { kind: "network", message: errMsg(e) }); }
  }, [token, locale]);
  useEffect(() => { void load(); }, [load]);

  const shell = (children: React.ReactNode, head?: { title: string; sub?: string; logo?: string | null; org?: string }) => (
    <div className="min-h-dvh">
      <header className="bg-[var(--color-12)] text-[var(--color-1)]">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
          {head?.logo ? <img src={head.logo} alt={head.org ?? ""} className="h-9 w-auto max-w-40 object-contain" /> : <Logo height={32} />}
          <div className="min-w-0 flex-1">{head && <><p className="truncate text-sm font-semibold">{head.title}</p>{head.sub && <p className="truncate text-xs text-[var(--color-2)]">{head.sub}</p>}</>}</div>
          <span className="hidden items-center gap-1.5 text-xs text-[var(--color-2)] sm:flex"><Lock className="size-3.5" aria-hidden />{t("secure")}</span>
          <LocaleSwitch onDark />
        </div>
      </header>
      {children}
    </div>
  );

  if (fatal) {
    const gone = fatal.kind === "gone"; const session = fatal.kind === "forbidden";
    return shell(<div className="mx-auto max-w-md px-4 py-16 text-center"><span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-surface-2"><AlertTriangle className="size-7" aria-hidden /></span>
      <h1 className="text-2xl font-semibold">{session ? t("sessionTitle") : gone ? t("goneTitle") : t("invalidTitle")}</h1><p className="mt-2 text-muted">{fatal.message}</p><p className="mt-1 text-sm text-muted">{t("contactSender")}</p>
      <Button className="mt-6" onClick={() => void load()}>{t("tryAgain")}</Button></div>);
  }
  if (!open) return shell(<div className="grid min-h-[60vh] place-items-center"><div className="flex items-center gap-3 text-muted"><Loader2 className="size-5 animate-spin" aria-hidden />{t("loading")}</div></div>);

  if (open.state === "signed") return shell(<Finished token={token} complete={open.contract.status === "COMPLETED"} already reference={open.contract.reference} />, { title: open.contract.name, sub: open.contract.reference });
  if (open.state === "verify") return shell(<>{open.replaced && <div className="mx-auto mt-6 max-w-md px-4"><Callout title={t("replaced")} /></div>}<VerifyStep token={token} method={open.method} emailHint={open.recipient.emailHint} onVerified={() => void load()} /></>, { title: open.contract.name, sub: open.contract.reference });
  if (done === "declined") return shell(<div className="mx-auto max-w-md px-4 py-16 text-center"><h1 className="text-2xl font-semibold">{t("declined")}</h1></div>, { title: open.contract.name });
  if (done) return shell(<Finished token={token} complete={done.complete} next={done.next} reference={open.contract.reference} />, { title: open.contract.name, sub: open.contract.reference, logo: open.branding.logoUrl, org: open.branding.orgName });
  return shell(<Signer view={open} token={token} onDone={(complete, next) => setDone({ complete, next })} onDeclined={() => setDone("declined")} />, { title: open.contract.name, sub: `${t("from", { name: open.contract.senderName || open.branding.orgName })} · ${t("expires", { date: fmtDate(open.contract.expiresAt, locale, { dateStyle: "medium" }) })}`, logo: open.branding.logoUrl, org: open.branding.orgName });
}

function Finished({ token, complete, next, already, reference }: { token: string; complete: boolean; next?: string[]; already?: boolean; reference: string }) {
  const t = useTranslations("signing.done");
  const [ready, setReady] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!complete || ready || tries > 20) return;
    const i = setTimeout(async () => { try { const r = await api<{ state: string; canDownload?: boolean }>(`/api/sign/${token}`); if (r.state === "signed" && r.canDownload) setReady(true); else setTries((n) => n + 1); } catch { setTries((n) => n + 1); } }, tries === 0 ? 300 : 3000);
    return () => clearTimeout(i);
  }, [complete, ready, tries, token]);
  return (
    <div className="mx-auto max-w-lg px-4 py-14 text-center">
      <span className="rise mx-auto mb-5 grid size-16 place-items-center rounded-full bg-accent text-accent-fg"><BadgeCheck className="size-9" aria-hidden /></span>
      <h1 className="text-3xl font-semibold tracking-tight">{already ? t("alreadyTitle") : complete ? t("titleComplete") : t("title")}</h1>
      <p className="mt-2 text-muted">{already ? t("alreadySub") : complete ? t("subComplete") : t("sub")}</p>
      {!complete && next && next.length > 0 && <p className="mt-3 text-sm">{t("waiting", { names: next.join(", ") })}</p>}
      {complete && (ready ? (
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <a href={`/api/sign/${token}/final?artifact=final`} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-sm font-medium text-accent-fg hover:brightness-95"><ArrowDownToLine className="size-4" aria-hidden />{t("download")}</a>
          <a href={`/api/sign/${token}/final?artifact=certificate`} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-6 text-sm font-medium hover:bg-surface-2"><FileCheck2 className="size-4" aria-hidden />{t("certificate")}</a>
        </div>) : <p className="mt-8 flex items-center justify-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />{t("preparing")}</p>)}
      <p className="num mt-10 text-xs text-muted">{reference}</p>
    </div>
  );
}

function Signer({ view, token, onDone, onDeclined }: { view: SignView; token: string; onDone: (complete: boolean, next: string[]) => void; onDeclined: () => void }) {
  const t = useTranslations("signing");
  const c = useTranslations("common");
  const locale = useLocale();
  const [vals, setVals] = useState<Record<string, Val>>(() => {
    const init: Record<string, Val> = {};
    for (const f of view.fields) if (f.defaultValue && TEXTUAL.has(f.type)) init[f.key] = { kind: "text", text: f.defaultValue };
    return init;
  });
  const [edit, setEdit] = useState<FieldDef | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [decline, setDecline] = useState(false);
  const [reason, setReason] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [sigCache, setSigCache] = useState<{ signature?: SigValue; initials?: SigValue }>({});
  const pageRefs = useRef<HTMLDivElement>(null);

  const fieldName = (f: FieldDef) => f.label || (f.type === "signature" ? t("tapToSign") : f.type === "initials" ? t("tapInitials") : f.type);
  const sorted = useMemo(() => [...view.fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [view.fields]);
  const isDone = (f: FieldDef) => !!vals[f.key] && (vals[f.key]!.kind !== "bool" || (vals[f.key] as { checked: boolean }).checked || !f.required);
  const filled = (f: FieldDef) => !!vals[f.key] && (vals[f.key]!.kind !== "text" || (vals[f.key] as { text: string }).text.trim() !== "");
  const pending = sorted.filter((f) => f.required && !(filled(f) && isDone(f)));
  const next = pending[0];
  const canFinish = pending.length === 0 && (!view.consent.required || consent);
  const activeKey = current ?? next?.key ?? null;

  const scrollTo = (k: string) => { pageRefs.current?.querySelector(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); };
  const go = () => { if (next) { setCurrent(next.key); scrollTo(next.key); } };
  const setVal = (k: string, v: Val) => { setVals((s) => ({ ...s, [k]: v })); setCurrent(null); };

  const activate = (f: FieldDef) => {
    if (f.type === "checkbox") { const cur = vals[f.key] as { checked: boolean } | undefined; setVal(f.key, { kind: "bool", checked: !cur?.checked }); return; }
    const cached = SIG.has(f.type) ? sigCache[f.type as "signature" | "initials"] : undefined;
    if (cached && !vals[f.key]) { setVal(f.key, { kind: "sig", sig: cached }); return; }
    setEdit(f);
  };
  const adopt = (f: FieldDef, v: SigValue, reuse: boolean) => {
    setVals((s) => { const n = { ...s, [f.key]: { kind: "sig", sig: v } as Val }; if (reuse) for (const o of view.fields) if (o.type === f.type && !n[o.key]) n[o.key] = { kind: "sig", sig: v }; return n; });
    if (reuse) setSigCache((s) => ({ ...s, [f.type]: v }));
    setEdit(null); setCurrent(null);
  };

  const geom = (f: { page: number; w: number; h: number }) => { const b = view.contract.pageGeometry[f.page]?.box ?? [0, 0, 595, 842]; return { w: (b[2]! - b[0]!) * f.w, h: (b[3]! - b[1]!) * f.h }; };
  const submit = async () => {
    if (!canFinish) { setErr(t("missing")); return; }
    setBusy(true); setErr(null);
    try {
      const fields: Record<string, unknown> = {};
      for (const f of view.fields) {
        const v = vals[f.key]; if (!v) continue;
        if (v.kind === "sig") fields[f.key] = { signature: v.sig };
        else if (v.kind === "bool") fields[f.key] = { value: { kind: "bool", checked: v.checked } };
        else if (v.kind === "attachment") fields[f.key] = { value: { kind: "attachment", objectId: v.objectId, bytes: v.bytes, mime: v.mime } };
        else if (v.text.trim()) { const g = geom(f); fields[f.key] = { value: { kind: "text", text: v.text }, ...(TEXTUAL.has(f.type) && !isWinAnsi(v.text) ? { renderedPng: renderTextPng(v.text, g.w, g.h) } : {}) }; }
      }
      const r = await api<{ contractComplete: boolean; next: string[] }>(`/api/sign/${token}/submit`, { json: { consent, locale, fields } });
      onDone(r.contractComplete, r.next);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const doDecline = async () => { try { await api(`/api/sign/${token}/decline`, { json: { reason } }); onDeclined(); } catch (e) { setErr(errMsg(e)); setDecline(false); } };

  const overlay = (page: number) => (
    <div className="absolute inset-0" dir="ltr">
      {view.filledByOthers.filter((o) => o.page === page).map((o) => <div key={o.key} className="absolute flex items-center justify-center overflow-hidden rounded-sm bg-surface/80 px-1 text-[10px] text-muted ring-1 ring-line" style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%` }} title={t("byOthers")}>{o.text ?? <ShieldCheck className="size-3" aria-label={t("byOthers")} />}</div>)}
      {view.fields.filter((f) => f.page === page).map((f) => {
        const v = vals[f.key]; const on = activeKey === f.key; const ok = !!v && filled(f);
        return (
          <button key={f.key} type="button" data-key={f.key} onClick={() => activate(f)} aria-label={`${fieldName(f)} — ${ok ? t("filled") : f.required ? t("required") : t("optional")}`}
            className={cn("absolute flex items-center justify-center overflow-hidden rounded-md border-2 px-1 text-xs transition", ok ? "border-accent bg-accent-soft" : "border-dashed border-fg bg-surface/85 hover:bg-accent-soft", on && !ok && "animate-pulse ring-4 ring-accent")}
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, color: "var(--color-4)" }}>
            {v?.kind === "sig" ? <img src={v.sig.imageDataUrl} alt={t("signed")} className="max-h-full max-w-full object-contain" />
              : v?.kind === "bool" ? <span className="text-base font-bold">{v.checked ? "✓" : ""}</span>
              : v?.kind === "text" ? <span className="truncate">{v.text}</span>
              : v?.kind === "attachment" ? <span className="truncate">📎 {v.name}</span>
              : <span className="flex items-center gap-1 truncate font-medium">{SIG.has(f.type) ? <PenLine className="size-3.5 shrink-0" aria-hidden /> : <Type className="size-3.5 shrink-0" aria-hidden />}{SIG.has(f.type) ? (f.type === "initials" ? t("tapInitials") : t("tapToSign")) : f.label || t("tapToFill")}{f.required && "*"}</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 pb-32 pt-6 sm:px-6 lg:grid-cols-[1fr_320px]">
      <div ref={pageRefs} className="min-w-0">
        {view.contract.message && <div className="mb-4"><Callout title={t("from", { name: view.contract.senderName })}>{view.contract.message}</Callout></div>}
        <PdfViewer src={`/api/sign/${token}/document`} overlay={overlay} />
      </div>
      <aside className="lg:sticky lg:top-6 lg:h-fit">
        <div className="space-y-4 rounded-card border border-line bg-surface p-5 shadow-card">
          <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ListChecks className="size-4" aria-hidden />{t("fields")}</h2>
            <p role="status" className="mt-1 text-sm text-muted">{t("fieldsLeft", { left: pending.length })}</p></div>
          <ul className="space-y-1.5">{sorted.map((f) => { const ok = filled(f) && isDone(f); return (
            <li key={f.key}><button type="button" onClick={() => { setCurrent(f.key); scrollTo(f.key); activate(f); }} className={cn("flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-start text-sm transition hover:bg-surface-2", activeKey === f.key && !ok ? "border-2 border-fg" : "border-line")}>
              {ok ? <CheckCircle2 className="size-4 shrink-0" aria-hidden /> : <span className="size-4 shrink-0 rounded-full border-2 border-dashed border-line-strong" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{fieldName(f)}</span><span className="text-xs text-muted">{f.required ? t("required") : t("optional")}</span></button></li>); })}</ul>
          {view.consent.required && <div className="border-t border-line pt-4"><h3 className="mb-2 text-sm font-semibold">{t("consent")}</h3><Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} label={<span className="text-sm">{view.consent.text}</span>} /></div>}
          {err && <Callout tone="warn" title={err} />}
          <div className="hidden space-y-2 lg:block"><Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!canFinish} onClick={submit}>{busy ? t("submitting") : t("submit")}</Button>
            {next && <Button className="w-full" onClick={go}>{t("next")}<ChevronRight className="size-4 rtl:rotate-180" aria-hidden /></Button>}</div>
          <button type="button" onClick={() => setDecline(true)} className="w-full text-center text-sm text-muted underline underline-offset-4 hover:text-fg">{t("decline")}</button>
          <div className="border-t border-line pt-4"><p className="num mb-2 text-xs text-muted">{t("progress", { signed: view.progress.signed, total: view.progress.total })}</p>
            <ul className="space-y-1.5 text-sm">{view.otherSigners.map((s, i) => <li key={i} className="flex items-center justify-between gap-2"><span className="truncate">{s.status === "you" ? t("you") : s.name}</span><span className="flex items-center gap-1 text-xs text-muted">{s.status === "signed" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <Clock className="size-3.5" aria-hidden />}{t(`sigStatus.${s.status}`)}</span></li>)}</ul></div>
          {view.branding.supportEmail && <p className="text-xs text-muted">{t("help", { email: view.branding.supportEmail })}</p>}
        </div>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 p-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-lg items-center gap-3"><p className="num min-w-0 flex-1 text-xs text-muted">{t("fieldsLeft", { left: pending.length })}</p>
          {canFinish ? <Button variant="primary" size="lg" loading={busy} onClick={submit}>{t("submit")}</Button> : <Button variant="primary" size="lg" onClick={go}>{pending.length === view.fields.filter((f) => f.required).length ? t("start") : t("next")}</Button>}</div>
        {view.consent.required && pending.length === 0 && !consent && <p className="mt-1 text-center text-xs">{t("consentRequired")}</p>}
      </div>

      {edit && SIG.has(edit.type) && <SignatureModal open kind={edit.type as "signature" | "initials"} name={view.recipient.name} allowed={view.methods} offerReuse={view.fields.filter((f) => f.type === edit.type).length > 1} onClose={() => setEdit(null)} onAdopt={(v, r) => adopt(edit, v, r)} />}
      {edit && !SIG.has(edit.type) && <ValueModal field={edit} token={token} current={vals[edit.key]} onClose={() => setEdit(null)} onSave={(v) => { setVal(edit.key, v); setEdit(null); }} />}
      <Modal open={decline} onClose={() => setDecline(false)} title={t("declineTitle")} description={t("declineDesc")} size="sm" footer={<><Button onClick={() => setDecline(false)}>{c("cancel")}</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={doDecline}>{t("declineConfirm")}</Button></>}>
        <Field label={t("declineReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus />}</Field>
      </Modal>
    </div>
  );
}

function ValueModal({ field: f, token, current, onClose, onSave }: { field: FieldDef; token: string; current: Val | undefined; onClose: () => void; onSave: (v: Val) => void }) {
  const t = useTranslations("signing.value");
  const c = useTranslations("common");
  const cur = current?.kind === "text" ? current.text : "";
  const [v, setV] = useState(cur || (f.type === "date" ? new Date().toISOString().slice(0, 10) : ""));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const val = f.validation as { maxLength?: number; min?: number | string; max?: number | string; decimals?: number; currency?: string; maxBytes?: number };
  const check = (): string | null => {
    const s = v.trim();
    if (f.type === "attachment") return file ? (val.maxBytes && file.size > val.maxBytes ? t("fileBig") : null) : null;
    if (!s) return null;
    if (val.maxLength && s.length > val.maxLength) return t("tooLong", { n: val.maxLength });
    if (f.type === "email" && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/.test(s)) return t("invalidEmail");
    if (f.type === "phone" && !/^\+[1-9]\d{6,14}$/.test(s.replace(/[\s-]/g, ""))) return t("invalidPhone");
    if ((f.type === "number" || f.type === "currency") && (!Number.isFinite(Number(s)) || (val.min !== undefined && Number(s) < Number(val.min)) || (val.max !== undefined && Number(s) > Number(val.max)))) return t("invalidNumber");
    return null;
  };
  const save = async () => {
    const problem = check(); if (problem) { setErr(problem); return; }
    if (f.type === "attachment") {
      if (!file) return; setBusy(true); setErr(null);
      try { const form = new FormData(); form.set("file", file); const r = await api<{ objectId: string; bytes: number; mime: string }>(`/api/sign/${token}/attachment`, { form }); onSave({ kind: "attachment", ...r, name: file.name }); }
      catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      return;
    }
    onSave({ kind: "text", text: f.type === "phone" ? v.replace(/[\s-]/g, "") : v.trim() });
  };
  const label = f.label || t("text");
  const input = f.type === "long_text" ? (p: object) => <Textarea {...p} value={v} onChange={(e) => setV(e.target.value)} maxLength={val.maxLength ?? 2000} autoFocus />
    : f.type === "dropdown" ? (p: object) => <Select {...p} value={v} onChange={(e) => setV(e.target.value)}><option value="">{t("pick")}</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
    : f.type === "radio" ? () => <div role="radiogroup" className="space-y-2">{f.options.map((o) => <label key={o} className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-line p-3 text-sm has-[:checked]:border-2 has-[:checked]:border-fg"><input type="radio" name="opt" checked={v === o} onChange={() => setV(o)} className="accent-[var(--color-5)]" />{o}</label>)}</div>
    : f.type === "attachment" ? (p: object) => <input {...p} type="file" accept={(val as { allowedMime?: string[] }).allowedMime?.join(",") ?? "application/pdf,image/png,image/jpeg"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm file:me-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-2" />
    : (p: object) => <Input {...p} type={f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : f.type === "number" || f.type === "currency" ? "number" : f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"} step={f.type === "number" ? (val.decimals ? 10 ** -val.decimals : 1) : f.type === "currency" ? "0.01" : undefined} dir={f.type === "email" || f.type === "phone" || f.type === "number" ? "ltr" : undefined} value={v} onChange={(e) => setV(e.target.value)} maxLength={val.maxLength} autoFocus />;
  return (
    <Modal open onClose={onClose} title={label} size="sm" footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={f.type === "attachment" ? !file : f.required && !v.trim()} onClick={save}>{busy ? t("uploading") : t("save")}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}><Field label={label} error={err} required={f.required}>{(p) => input(p)}</Field>{f.type === "currency" && val.currency && <p className="mt-1 text-xs text-muted">{val.currency}</p>}<button type="submit" hidden /></form>
    </Modal>
  );
}
