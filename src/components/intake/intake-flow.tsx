"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, Lock, PenLine, ShieldCheck, Upload } from "lucide-react";
import { LocaleSwitch } from "@/components/app/locale-switch";
import { SignatureModal, type SigValue } from "@/components/signing/signature-modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Logo } from "@/components/ui/logo";
import { ApiError, api, errMsg } from "@/lib/api";
import { progress, visibility, type FormSchema } from "@/server/intake/schema";

type PubField = { key: string; type: string; label: string; help?: string; placeholder?: string; required?: boolean; options?: Array<{ value: string; label: string }>; acknowledgement?: string; accept?: string[]; maxFiles?: number; visibleWhen?: unknown };
type PubSection = { key: string; title: string; description?: string; visibleWhen?: unknown; fields: PubField[] };
type View =
  | { state: "verify"; method: "EMAIL_OTP" | "PASSCODE"; title: string; emailHint: string }
  | { state: "submitted"; title: string; submittedAt: string | null }
  | { state: "form"; title: string; description: string; language: string; branding: { displayName: string; color: string | null }; schema: { sections: PubSection[] }; answers: Record<string, unknown>; files: Array<{ id: string; field: string; name: string; size: number }>; rev: number; status: string; privacyNotice: string | null; expiresAt: string; allowResume: boolean };
type Problem = { key: string; message: string };
type FileRef = { fileId: string; filename: string };

const BEAT_MS = 30_000;
const now = () => Date.now();
const clientInfo = () => ({ screenWidth: window.screen.width, screenHeight: window.screen.height, pixelRatio: window.devicePixelRatio, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform });

export function IntakeFlow({ token }: { token: string }) {
  const t = useTranslations("intake.public");
  const locale = useLocale();
  const [view, setView] = useState<View | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState(0);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idem = useRef("");
  const lastActive = useRef(0);
  const sentClient = useRef(false);
  const seenSections = useRef(new Set<string>());

  useEffect(() => { lastActive.current = now(); idem.current = crypto.randomUUID(); }, []);
  const load = useCallback(async () => {
    try { const v = await api<View>(`/api/intake/${token}`); setView(v); if (v.state === "form") setAnswers(v.answers); setFatal(null); }
    catch (e) { setFatal(e instanceof ApiError ? e.code : "network"); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const form = view?.state === "form" ? view : null;
  const model = useMemo(() => (form ? ({ sections: form.schema.sections } as unknown as FormSchema) : null), [form]);
  const vis = useMemo(() => (model ? visibility(model, answers) : null), [model, answers]);
  const sections = useMemo(() => (form && vis ? form.schema.sections.filter((s) => vis.sections.get(s.key)) : []), [form, vis]);
  const prog = useMemo(() => (model ? progress(model, answers) : null), [model, answers]);
  const cur = sections[Math.min(step, Math.max(0, sections.length - 1))];

  // ------------------------------------------------------------ save
  const flush = useCallback(async (explicit = false) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const patch = pending.current;
    if (!Object.keys(patch).length && !explicit) return true;
    pending.current = {};
    setSaving("saving");
    try {
      await api(`/api/intake/${token}/save`, { json: { patch, explicit } });
      setSaving("saved"); setSavedAt(new Date()); setProblems((p) => p.filter((x) => !(x.key in patch)));
      return true;
    } catch (e) {
      pending.current = { ...patch, ...pending.current };
      setSaving("error");
      if (e instanceof ApiError && e.code === "validation_failed") setProblems((e.details as { problems?: Problem[] } | undefined)?.problems ?? []);
      return false;
    }
  }, [token]);
  const change = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    pending.current[key] = value === "" || value === undefined ? null : value;
    lastActive.current = now();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1500);
  };

  // ------------------------------------------------------------ analytics heartbeat (coarse device facts only; never answers)
  const beat = useCallback((extra: Record<string, unknown> = {}) => {
    const active = document.visibilityState === "visible" && now() - lastActive.current < 60_000;
    const body = { active, ...(sentClient.current ? {} : { client: clientInfo() }), ...extra };
    sentClient.current = true;
    void api(`/api/intake/${token}/beat`, { json: body }).catch(() => undefined);
  }, [token]);
  useEffect(() => {
    if (!form) return;
    beat();
    const id = setInterval(() => beat(), BEAT_MS);
    const onVis = () => { if (document.visibilityState === "hidden") { void flush(); beat({ closing: true }); } };
    const touch = () => { lastActive.current = now(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointerdown", touch); window.addEventListener("keydown", touch); window.addEventListener("scroll", touch, { passive: true });
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pointerdown", touch); window.removeEventListener("keydown", touch); window.removeEventListener("scroll", touch); };
  }, [form !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cur || seenSections.current.has(cur.key)) return;
    seenSections.current.add(cur.key);
    beat({ section: { key: cur.key, state: "entered" } });
  }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setSubmitting(true); setProblems([]);
    try {
      if (!(await flush())) throw new Error(t("saveFailed"));
      await api(`/api/intake/${token}/submit`, { json: {}, idempotencyKey: idem.current });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "validation_failed") {
        const ps = (e.details as { problems?: Problem[] } | undefined)?.problems ?? [];
        setProblems(ps);
        const idx = sections.findIndex((s) => s.fields.some((f) => ps.some((p) => p.key === f.key)));
        if (idx >= 0) setStep(idx);
      } else setProblems([{ key: "", message: errMsg(e) }]);
    } finally { setSubmitting(false); }
  };
  const next = async () => {
    if (!cur) return;
    void beat({ section: { key: cur.key, state: "completed" } });
    await flush();
    setStep((s) => Math.min(s + 1, sections.length - 1));
    window.scrollTo({ top: 0 });
  };

  // ------------------------------------------------------------ chrome
  const brand = form?.branding;
  const shell = (children: React.ReactNode) => (
    <div className="min-h-dvh" dir={locale === "fa" ? "rtl" : "ltr"} style={brand?.color ? ({ "--color-accent": brand.color } as React.CSSProperties) : undefined}>
      <header className="bg-[var(--color-12)] text-[var(--color-1)]"><div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3 sm:px-6"><Logo height={30} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{view && "title" in view ? view.title : t("title")}</p>{brand?.displayName && <p className="truncate text-xs text-[var(--color-2)]">{brand.displayName}</p>}</div><span className="hidden items-center gap-1.5 text-xs text-[var(--color-2)] sm:flex"><Lock className="size-3.5" aria-hidden />{t("secure")}</span><LocaleSwitch onDark /></div></header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );

  if (fatal) return shell(<div className="rounded-card border border-line bg-surface p-8 text-center shadow-card"><h1 className="mb-2 text-lg font-semibold">{t(`fatal.${["gone", "not_found", "rate_limited"].includes(fatal) ? fatal : "generic"}.title` as never)}</h1><p className="text-muted">{t(`fatal.${["gone", "not_found", "rate_limited"].includes(fatal) ? fatal : "generic"}.body` as never)}</p></div>);
  if (!view) return shell(<div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-muted" aria-label={t("loading")} /></div>);
  if (view.state === "verify") return shell(<Verify token={token} view={view} onDone={load} />);
  if (view.state === "submitted" || done) return shell(<div className="rounded-card border border-line bg-surface p-8 text-center shadow-card"><CheckCircle2 className="mx-auto mb-3 size-10 text-ok" aria-hidden /><h1 className="mb-2 text-xl font-semibold">{t("submitted.title")}</h1><p className="text-muted">{t("submitted.body")}</p></div>);
  if (!form || !cur || !prog) return null;

  const last = step >= sections.length - 1;
  const errFor = (k: string) => problems.find((p) => p.key === k)?.message ?? null;
  return shell(
    <div className="space-y-5">
      {form.description && <p className="text-muted">{form.description}</p>}
      {form.privacyNotice && <Callout tone="info" icon={<ShieldCheck className="size-4" />}>{form.privacyNotice}</Callout>}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm"><span className="font-medium">{t("progress", { percent: prog.percent })}</span><span className="text-muted" aria-live="polite">{saving === "saving" ? t("saving") : saving === "saved" && savedAt ? t("savedAt", { time: savedAt.toLocaleTimeString(locale) }) : saving === "error" ? t("saveError") : ""}</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={prog.percent} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-accent transition-all" style={{ width: `${prog.percent}%` }} /></div>
        <ol className="scroll-thin mt-3 flex gap-1 overflow-x-auto" aria-label={t("steps")}>{sections.map((s, i) => <li key={s.key}><button type="button" onClick={() => { void flush(); setStep(i); }} aria-current={i === step ? "step" : undefined} className={cn("whitespace-nowrap rounded-full px-3 py-1.5 text-sm", i === step ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>{i + 1}. {s.title}</button></li>)}</ol>
      </div>
      <section aria-labelledby="sec-title" className="rounded-card border border-line bg-surface p-5 shadow-card sm:p-6">
        <h1 id="sec-title" className="text-lg font-semibold">{cur.title}</h1>
        {cur.description && <p className="mt-1 text-sm text-muted">{cur.description}</p>}
        <div className="mt-5 space-y-5">{cur.fields.filter((f) => vis?.fields.get(f.key) !== false).map((f) => <FieldInput key={f.key} token={token} f={f} value={answers[f.key]} files={form.files} error={errFor(f.key)} onChange={(v) => change(f.key, v)} onFlush={() => void flush()} />)}</div>
      </section>
      {problems.some((p) => !p.key) && <Callout tone="warn">{problems.filter((p) => !p.key).map((p) => p.message).join(" ")}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={step === 0} onClick={() => { void flush(); setStep(step - 1); }}><ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />{t("back")}</Button>
        {form.allowResume && <Button onClick={async () => { if (await flush(true)) setSaving("saved"); }}>{t("saveLater")}</Button>}
        <div className="ms-auto">{last ? <Button variant="primary" loading={submitting} onClick={submit}>{t("submit")}</Button> : <Button variant="primary" onClick={next}>{t("next")}<ChevronRight className="size-4 rtl:rotate-180" aria-hidden /></Button>}</div>
      </div>
      <p className="text-xs text-muted">{t("draftNote")}</p>
    </div>,
  );
}

function Verify({ token, view, onDone }: { token: string; view: Extract<View, { state: "verify" }>; onDone: () => void }) {
  const t = useTranslations("intake.public.verify");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const post = async (json: unknown) => { setBusy(true); setErr(null); try { await api(`/api/intake/${token}/verify`, { json }); return true; } catch (e) { setErr(errMsg(e)); return false; } finally { setBusy(false); } };
  return (
    <div className="mx-auto max-w-md rounded-card border border-line bg-surface p-6 shadow-card">
      <h1 className="mb-1 text-lg font-semibold">{t("title")}</h1>
      {view.method === "EMAIL_OTP" ? <>
        <p className="mb-4 text-sm text-muted">{t("otpBody", { email: view.emailHint })}</p>
        {!sent ? <Button variant="primary" loading={busy} onClick={async () => { if (await post({ action: "request_code" })) setSent(true); }}>{t("sendCode")}</Button> : <div className="space-y-3"><Field label={t("code")} error={err}>{(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} />}</Field><Button variant="primary" loading={busy} disabled={code.length < 4} onClick={async () => { if (await post({ action: "verify_code", code })) onDone(); }}>{t("verify")}</Button></div>}
      </> : <div className="space-y-3"><p className="text-sm text-muted">{t("passcodeBody")}</p><Field label={t("passcode")} error={err}>{(p) => <Input {...p} type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />}</Field><Button variant="primary" loading={busy} disabled={!code} onClick={async () => { if (await post({ action: "verify_passcode", passcode: code })) onDone(); }}>{t("verify")}</Button></div>}
      {sent && err === null && <p className="mt-3 text-xs text-muted">{t("sentNote")}</p>}
    </div>
  );
}

const COUNTRIES = ["GB", "AE", "US", "DE", "FR", "NL", "ES", "IE", "IT", "CA", "AU", "SA", "TR", "SG", "IN"];

function FieldInput({ token, f, value, files, error, onChange, onFlush }: { token: string; f: PubField; value: unknown; files: Array<{ id: string; field: string; name: string }>; error: string | null; onChange: (v: unknown) => void; onFlush: () => void }) {
  const t = useTranslations("intake.public");
  const [sig, setSig] = useState(false);
  const [up, setUp] = useState<"" | "busy">("");
  const [upErr, setUpErr] = useState<string | null>(null);
  const obj = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, string>;
  const sub = (k: string, v: string) => onChange({ ...obj, [k]: v });
  const cc = (props: { value: string; onChange: (v: string) => void; label?: string }) => <Select aria-label={props.label ?? t("country")} value={props.value} onChange={(e) => props.onChange(e.target.value)}><option value="">—</option>{COUNTRIES.map((c) => <option key={c} value={c}>{new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "region" }).of(c) ?? c}</option>)}</Select>;
  const str = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const upload = async (file: File) => {
    setUp("busy"); setUpErr(null);
    try {
      const fd = new FormData(); fd.set("file", file); fd.set("field", f.key);
      const r = await api<{ fileId: string; filename: string }>(`/api/intake/${token}/upload`, { form: fd });
      onChange(f.type === "file" ? r : [...(Array.isArray(value) ? value : []), r]); onFlush();
    } catch (e) { setUpErr(errMsg(e)); } finally { setUp(""); }
  };
  const uploaded: FileRef[] = f.type === "file" ? (value && typeof value === "object" && "fileId" in (value as object) ? [value as FileRef] : []) : Array.isArray(value) ? (value as FileRef[]) : [];
  const remove = async (id: string) => { await api(`/api/intake/${token}/files/${id}`, { method: "DELETE" }).catch(() => undefined); onChange(f.type === "file" ? null : uploaded.filter((x) => x.fileId !== id)); };

  const wrap = (child: (p: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode) => <Field label={f.label} hint={f.help} error={error} required={f.required}>{child}</Field>;
  switch (f.type) {
    case "long_text": return wrap((p) => <Textarea {...p} placeholder={f.placeholder} value={str} onChange={(e) => onChange(e.target.value)} />);
    case "dropdown": return wrap((p) => <Select {...p} value={str} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>);
    case "radio": return wrap(() => <div role="radiogroup" aria-label={f.label} className="space-y-1.5">{f.options?.map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" name={f.key} checked={str === o.value} onChange={() => onChange(o.value)} />{o.label}</label>)}</div>);
    case "checkbox": return <div><Checkbox label={f.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />{error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}</div>;
    case "acknowledgement": return <div><Checkbox label={f.acknowledgement ?? f.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />{error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}</div>;
    case "country": return wrap(() => cc({ value: str, onChange, label: f.label }));
    case "person": return wrap(() => <div className="grid gap-2 sm:grid-cols-3"><Input aria-label={t("name")} placeholder={t("name")} value={obj.name ?? ""} onChange={(e) => sub("name", e.target.value)} /><Input aria-label={t("email")} type="email" placeholder={t("email")} value={obj.email ?? ""} onChange={(e) => sub("email", e.target.value)} /><Input aria-label={t("phone")} type="tel" placeholder={t("phone")} value={obj.phone ?? ""} onChange={(e) => sub("phone", e.target.value)} /></div>);
    case "company": return wrap(() => <div className="grid gap-2 sm:grid-cols-2"><Input aria-label={t("companyName")} placeholder={t("companyName")} value={obj.name ?? ""} onChange={(e) => sub("name", e.target.value)} /><Input aria-label={t("regNumber")} placeholder={t("regNumber")} value={obj.registrationNumber ?? ""} onChange={(e) => sub("registrationNumber", e.target.value)} />{cc({ value: obj.country ?? "", onChange: (v) => sub("country", v) })}</div>);
    case "address": return wrap(() => <div className="grid gap-2 sm:grid-cols-2"><Input className="sm:col-span-2" aria-label={t("line1")} placeholder={t("line1")} value={obj.line1 ?? ""} onChange={(e) => sub("line1", e.target.value)} /><Input aria-label={t("line2")} placeholder={t("line2")} value={obj.line2 ?? ""} onChange={(e) => sub("line2", e.target.value)} /><Input aria-label={t("city")} placeholder={t("city")} value={obj.city ?? ""} onChange={(e) => sub("city", e.target.value)} /><Input aria-label={t("postcode")} placeholder={t("postcode")} value={obj.postcode ?? ""} onChange={(e) => sub("postcode", e.target.value)} />{cc({ value: obj.country ?? "", onChange: (v) => sub("country", v) })}</div>);
    case "file": case "files": return wrap(() => (
      <div className="space-y-2">
        <ul className="space-y-1 text-sm">{uploaded.map((u) => <li key={u.fileId} className="flex items-center gap-2"><span className="truncate">{u.filename ?? files.find((x) => x.id === u.fileId)?.name}</span><button type="button" className="text-danger underline" onClick={() => void remove(u.fileId)}>{t("remove")}</button></li>)}</ul>
        {(f.type === "files" || !uploaded.length) && <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-line-strong p-3 text-sm hover:bg-surface-2"><Upload className="size-5" aria-hidden />{up ? t("uploading") : t("chooseFile")}<input type="file" className="sr-only" accept={(f.accept ?? ["pdf", "png", "jpg"]).map((x) => (x === "jpg" ? ".jpg,.jpeg" : `.${x}`)).join(",")} onChange={(e) => { const x = e.target.files?.[0]; if (x) void upload(x); e.target.value = ""; }} /></label>}
        {upErr && <p role="alert" className="text-sm text-danger">{upErr}</p>}
      </div>));
    case "signature": case "initials": {
      const v = value as { kind?: string; text?: string; dataUrl?: string } | undefined;
      return wrap(() => (<div>
        {v?.kind === "drawn" && v.dataUrl ? <img src={v.dataUrl} alt={f.label} className="mb-2 h-16 rounded-lg border border-line bg-white p-1" /> : v?.kind === "typed" ? <p className="mb-2 rounded-lg border border-line px-3 py-2 font-serif text-xl italic">{v.text}</p> : null}
        <Button onClick={() => setSig(true)}><PenLine className="size-4" aria-hidden />{v ? t("change") : f.type === "signature" ? t("addSignature") : t("addInitials")}</Button>
        <SignatureModal open={sig} kind={f.type as "signature" | "initials"} name="" allowed={{ typed: true, drawn: true, uploaded: false }} onClose={() => setSig(false)} onAdopt={(s: SigValue) => { onChange(s.method === "DRAWN" ? { kind: "drawn", dataUrl: s.imageDataUrl } : { kind: "typed", text: s.typedText ?? "" }); setSig(false); }} />
      </div>));
    }
    default: {
      const type = ({ email: "email", phone: "tel", number: "number", currency: "number", date: "date", time: "time", datetime: "datetime-local" } as Record<string, string>)[f.type] ?? "text";
      return wrap((p) => <Input {...p} type={type} inputMode={f.type === "currency" || f.type === "number" ? "decimal" : undefined} step={f.type === "currency" ? "0.01" : undefined} placeholder={f.placeholder} value={str} onChange={(e) => onChange(e.target.value)} />);
    }
  }
}
