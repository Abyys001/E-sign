"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Bell, Building2, Clock, FileSignature, Globe, Lock, Mail, MessageSquare, Palette, ShieldCheck, Trash2, type LucideIcon } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";
import { useTranslations as useT } from "next-intl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = any;
const SECTIONS: Array<{ id: string; icon: LucideIcon; sensitive?: boolean }> = [
  { id: "general", icon: Globe }, { id: "branding", icon: Palette }, { id: "signing", icon: FileSignature }, { id: "email", icon: Mail, sensitive: true }, { id: "sms", icon: MessageSquare, sensitive: true },
  { id: "notifications", icon: Bell }, { id: "reminders", icon: Clock }, { id: "retention", icon: Trash2, sensitive: true }, { id: "privacy", icon: ShieldCheck, sensitive: true }, { id: "security", icon: Lock, sensitive: true }, { id: "emailTemplates", icon: Building2 },
];

export default function SettingsPage() { return <Suspense><Settings /></Suspense>; }

function Settings() {
  const t = useTranslations("settings");
  const router = useRouter();
  const sp = useSearchParams();
  const sec = sp.get("s") ?? "general";
  const { data, reload } = useApi<S>("/api/settings");
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label={t("title")} className="scroll-thin flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {SECTIONS.map((s) => { const I = s.icon; const on = sec === s.id; return (
            <button key={s.id} type="button" aria-current={on ? "page" : undefined} onClick={() => router.replace(`/settings?s=${s.id}`, { scroll: false })} className={cn("flex items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm transition", on ? "bg-surface font-medium shadow-card ring-1 ring-line" : "text-muted hover:bg-surface-2 hover:text-fg")}><I className="size-4" aria-hidden />{t(`sections.${s.id}` as never)}</button>); })}
        </nav>
        <div className="min-w-0">{!data ? <Skeleton className="h-96" /> : sec === "emailTemplates" ? <EmailTemplates /> : sec === "branding" ? <Branding /> : <Section key={sec} id={sec} data={data} reload={reload} />}</div>
      </div>
    </div>
  );
}

function Section({ id, data, reload }: { id: string; data: S; reload: () => Promise<void> }) {
  const t = useTranslations("settings");
  const toast = useToast();
  const ensure = useElevation();
  const { reload: reloadMe } = useMe();
  const [v, setV] = useState<S>(() => structuredClone(data[id]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sensitive = SECTIONS.find((s) => s.id === id)?.sensitive;
  const set = (k: string, val: unknown) => setV((s: S) => ({ ...s, [k]: val }));
  const save = async () => {
    if (sensitive && !(await ensure())) return;
    setBusy(true); setErr(null);
    try { await api("/api/settings", { method: "PATCH", json: { [id]: v } }); toast("ok", t("saved")); await reload(); await reloadMe(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title={t(`sections.${id}` as never)} />
      <form className="space-y-5 p-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {id === "general" && <General v={v} set={set} />}
        {id === "signing" && <Signing v={v} set={set} />}
        {id === "email" && <EmailForm v={v} set={set} />}
        {id === "sms" && <SmsForm v={v} set={set} />}
        {id === "notifications" && <Notifs v={v} set={set} />}
        {id === "reminders" && <Reminders v={v} set={set} />}
        {id === "retention" && <Retention v={v} set={set} />}
        {id === "privacy" && <Privacy v={v} set={set} />}
        {id === "security" && <Security v={v} set={set} />}
        {err && <Callout tone="warn" title={err} />}
        <div className="flex justify-end border-t border-line pt-4"><Button type="submit" variant="primary" loading={busy}>{t("save")}</Button></div>
      </form>
    </Card>
  );
}

const Row = ({ children, cols = 2 }: { children: React.ReactNode; cols?: 1 | 2 | 3 }) => <div className={cn("grid gap-4", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3")}>{children}</div>;
const Toggle = ({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (b: boolean) => void; hint?: string }) => <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium">{label}</p>{hint && <p className="text-xs text-muted">{hint}</p>}</div><Switch label={label} checked={value} onChange={onChange} /></div>;
const num = (f: (n: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => f(Number(e.target.value));

function General({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.general");
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { return ["UTC"]; } }, []);
  return (<>
    <Row><Field label={t("timezone")} hint={t("timezoneHint")}>{(p) => <Select {...p} value={v.timezone} onChange={(e) => set("timezone", e.target.value)}>{["UTC", ...zones.filter((z) => z !== "UTC")].map((z) => <option key={z}>{z}</option>)}</Select>}</Field>
      <Field label={t("locale")}>{(p) => <Select {...p} value={v.locale} onChange={(e) => set("locale", e.target.value)}><option value="en">English</option><option value="fa">فارسی</option></Select>}</Field></Row>
    <Row><Field label={t("currency")}>{(p) => <Input {...p} dir="ltr" maxLength={3} value={v.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />}</Field>
      <Field label={t("prefix")} hint={t("prefixHint")}>{(p) => <Input {...p} dir="ltr" maxLength={8} value={v.referencePrefix} onChange={(e) => set("referencePrefix", e.target.value.toUpperCase())} />}</Field></Row>
    <Field label={t("scope")}>{(p) => <Select {...p} value={v.referenceScope} onChange={(e) => set("referenceScope", e.target.value)}><option value="organisation">{t("scopeOrg")}</option><option value="global">{t("scopeGlobal")}</option></Select>}</Field>
  </>);
}

function Signing({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.signing");
  const c = useTranslations("common");
  const smsOn = true;
  return (<>
    <Row cols={3}><Field label={t("expiry")}>{(p) => <Input {...p} type="number" min={1} max={365} value={v.defaultExpiryDays} onChange={num((n) => set("defaultExpiryDays", n))} />}</Field>
      <Field label={t("auth")}>{(p) => <Select {...p} value={v.defaultAuthLevel} onChange={(e) => set("defaultAuthLevel", e.target.value)}>{["LINK", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"].filter((a) => smsOn || a !== "SMS_OTP").map((a) => <option key={a} value={a}>{c(`auth.${a}`)}</option>)}</Select>}</Field>
      <Field label={t("order")}>{(p) => <Select {...p} value={v.defaultSigningOrder} onChange={(e) => set("defaultSigningOrder", e.target.value)}><option value="SEQUENTIAL">{t("sequential")}</option><option value="PARALLEL">{t("parallel")}</option></Select>}</Field></Row>
    <fieldset><legend className="mb-2 text-sm font-medium">{t("methods")}</legend><div className="flex flex-wrap gap-x-6 gap-y-2"><Checkbox label={t("typed")} checked={v.allowTyped} onChange={(e) => set("allowTyped", e.target.checked)} /><Checkbox label={t("drawn")} checked={v.allowDrawn} onChange={(e) => set("allowDrawn", e.target.checked)} /><Checkbox label={t("uploaded")} checked={v.allowUploaded} onChange={(e) => set("allowUploaded", e.target.checked)} /></div></fieldset>
    <Row cols={3}><Field label={t("tokenTtl")}>{(p) => <Input {...p} type="number" min={1} value={v.tokenTtlHours} onChange={num((n) => set("tokenTtlHours", n))} />}</Field>
      <Field label={t("otpTtl")}>{(p) => <Input {...p} type="number" min={1} max={60} value={v.otpTtlMinutes} onChange={num((n) => set("otpTtlMinutes", n))} />}</Field>
      <Field label={t("otpAttempts")}>{(p) => <Input {...p} type="number" min={1} max={10} value={v.otpMaxAttempts} onChange={num((n) => set("otpMaxAttempts", n))} />}</Field></Row>
    <Toggle label={t("consentRequired")} value={v.consentRequired} onChange={(b) => set("consentRequired", b)} />
    <Field label={t("consentEn")}>{(p) => <Textarea {...p} value={v.consentText.en} onChange={(e) => set("consentText", { ...v.consentText, en: e.target.value })} />}</Field>
    <Field label={t("consentFa")}>{(p) => <Textarea {...p} dir="rtl" lang="fa" value={v.consentText.fa} onChange={(e) => set("consentText", { ...v.consentText, fa: e.target.value })} />}</Field>
    <Toggle label={t("includeIp")} value={v.includeIpOnCertificate} onChange={(b) => set("includeIpOnCertificate", b)} />
    <Toggle label={t("publicVerification")} value={v.publicVerification} onChange={(b) => set("publicVerification", b)} />
  </>);
}

function EmailForm({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.email");
  const toast = useToast();
  const ensure = useElevation();
  const [busy, setBusy] = useState(false);
  const [busy2, setBusy2] = useState(false);
  const verify = async () => { if (!(await ensure())) return; setBusy2(true); try { const r = await api<{ host: string; port: number; authenticated: boolean }>("/api/settings/email-verify", { method: "POST", json: {} }); toast("ok", t(r.authenticated ? "verifiedAuth" : "verified", { host: r.host, port: r.port })); } catch (e) { toast("error", errMsg(e)); } finally { setBusy2(false); } };
  const test = async () => { if (!(await ensure())) return; setBusy(true); try { const r = await api<{ to: string }>("/api/settings/email-test", { method: "POST", json: {} }); toast("ok", t("testSent", { to: r.to })); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  return (<>
    <Toggle label={t("useOrg")} hint={t("useOrgHint")} value={v.useOrgSmtp} onChange={(b) => set("useOrgSmtp", b)} />
    {v.useOrgSmtp && <>
      <Row><Field label={t("host")}>{(p) => <Input {...p} dir="ltr" value={v.host} onChange={(e) => set("host", e.target.value)} />}</Field><Field label={t("port")}>{(p) => <Input {...p} type="number" min={1} max={65535} value={v.port} onChange={num((n) => set("port", n))} />}</Field></Row>
      <Checkbox label={t("secure")} checked={v.secure} onChange={(e) => set("secure", e.target.checked)} />
      <Row><Field label={t("user")}>{(p) => <Input {...p} dir="ltr" autoComplete="off" value={v.user} onChange={(e) => set("user", e.target.value)} />}</Field><Field label={t("password")} hint={v.passwordEnc ? t("passwordSet") : undefined}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={v.password ?? ""} onChange={(e) => set("password", e.target.value)} />}</Field></Row></>}
    <Row><Field label={t("fromName")}>{(p) => <Input {...p} value={v.fromName} onChange={(e) => set("fromName", e.target.value)} />}</Field><Field label={t("fromAddress")}>{(p) => <Input {...p} type="email" dir="ltr" value={v.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} />}</Field></Row>
    <Field label={t("replyTo")}>{(p) => <Input {...p} type="email" dir="ltr" value={v.replyTo} onChange={(e) => set("replyTo", e.target.value)} />}</Field>
    {v.useOrgSmtp && <Field label={t("headers")} hint={t("headersHint")}>{(p) => <Textarea {...p} dir="ltr" defaultValue={Object.entries(v.headers ?? {}).map(([k, x]) => `${k}: ${x}`).join("\n")} onBlur={(e) => set("headers", Object.fromEntries(e.target.value.split("\n").map((l: string) => l.split(/:(.*)/s)).filter((q: string[]) => q[0]?.trim() && q[1]?.trim()).map((q: string[]) => [q[0]!.trim(), q[1]!.trim()])))} />}</Field>}
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 p-3"><Button loading={busy2} onClick={verify}>{t("verify")}</Button><Button loading={busy} onClick={test}>{t("test")}</Button><span className="text-xs text-muted">{t("testHint")}</span></div>
  </>);
}

function SmsForm({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.sms");
  const toast = useToast();
  const ensure = useElevation();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const test = async () => { if (!(await ensure())) return; setBusy(true); try { await api("/api/settings/sms-test", { json: { to } }); toast("ok", t("testSent")); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  const cb = typeof window === "undefined" ? "" : `${window.location.origin}/api/webhooks/sms-status`;
  return (<>
    <Callout title={t("hint")} />
    <Toggle label={t("enabled")} value={v.enabled} onChange={(b) => set("enabled", b)} />
    <Field label={t("provider")}>{(p) => <Select {...p} value={v.provider} onChange={(e) => set("provider", e.target.value)}><option value="none">{t("none")}</option><option value="twilio">{t("twilio")}</option></Select>}</Field>
    {v.provider === "twilio" && <>
      <Row><Field label={t("accountId")}>{(p) => <Input {...p} dir="ltr" autoComplete="off" value={v.accountId} onChange={(e) => set("accountId", e.target.value)} />}</Field><Field label={t("authToken")} hint={v.authTokenEnc ? t("tokenSet") : undefined}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={v.authToken ?? ""} onChange={(e) => set("authToken", e.target.value)} />}</Field></Row>
      <Field label={t("from")}>{(p) => <Input {...p} dir="ltr" placeholder="+447700900123" value={v.fromNumber} onChange={(e) => set("fromNumber", e.target.value)} />}</Field>
      <Field label={t("callback")}>{(p) => <Input {...p} dir="ltr" readOnly value={cb} onFocus={(e) => e.currentTarget.select()} />}</Field>
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-surface-2 p-3"><div className="min-w-56 flex-1"><Field label={t("testTo")}>{(p) => <Input {...p} dir="ltr" placeholder="+447700900123" value={to} onChange={(e) => setTo(e.target.value)} />}</Field></div><Button loading={busy} disabled={!/^\+[1-9]\d{6,14}$/.test(to)} onClick={test}>{t("test")}</Button></div></>}
  </>);
}

function Notifs({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.notifications");
  return (<><Toggle label={t("onView")} value={v.notifySenderOnView} onChange={(b) => set("notifySenderOnView", b)} /><Toggle label={t("onSign")} value={v.notifySenderOnSign} onChange={(b) => set("notifySenderOnSign", b)} /><Toggle label={t("completedToSigners")} value={v.emailCompletedToSigners} onChange={(b) => set("emailCompletedToSigners", b)} /><Toggle label={t("attach")} value={v.attachFinalPdfToEmail} onChange={(b) => set("attachFinalPdfToEmail", b)} /></>);
}

function Reminders({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.reminders");
  const list = (s: string) => s.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const [after, setAfter] = useState(v.afterHours.join(", "));
  const [before, setBefore] = useState(v.beforeExpiryDays.join(", "));
  return (<><Callout title={t("hint")} /><Toggle label={t("enabled")} value={v.enabled} onChange={(b) => set("enabled", b)} />
    <Row><Field label={t("after")}>{(p) => <Input {...p} dir="ltr" value={after} onChange={(e) => { setAfter(e.target.value); set("afterHours", list(e.target.value)); }} />}</Field><Field label={t("before")}>{(p) => <Input {...p} dir="ltr" value={before} onChange={(e) => { setBefore(e.target.value); set("beforeExpiryDays", list(e.target.value)); }} />}</Field></Row></>);
}

function Retention({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.retention");
  const opts = () => ["never", "1y", "3y", "5y", "7y", "custom"].map((o) => <option key={o} value={o}>{o === "never" ? t("never") : o === "custom" ? t("customOpt") : t(`y${o[0]}` as never)}</option>);
  return (<>
    <Row><Field label={t("documents")}>{(p) => <Select {...p} value={v.documents} onChange={(e) => set("documents", e.target.value)}>{opts()}</Select>}</Field>
      {v.documents === "custom" && <Field label={t("custom")}>{(p) => <Input {...p} type="number" min={30} value={v.documentsCustomDays} onChange={num((n) => set("documentsCustomDays", n))} />}</Field>}</Row>
    <Row><Field label={t("audit")}>{(p) => <Select {...p} value={v.audit} onChange={(e) => set("audit", e.target.value)}>{opts()}</Select>}</Field>
      {v.audit === "custom" && <Field label={t("custom")}>{(p) => <Input {...p} type="number" min={30} value={v.auditCustomDays} onChange={num((n) => set("auditCustomDays", n))} />}</Field>}</Row>
    <Field label={t("warn")}>{(p) => <Input {...p} type="number" min={1} max={365} value={v.warnDays} onChange={num((n) => set("warnDays", n))} />}</Field>
    <Toggle label={t("auto")} value={v.autoDelete} onChange={(b) => set("autoDelete", b)} />
    {v.autoDelete && <Callout tone="warn" title={t("autoWarn")} />}
  </>);
}

function Privacy({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.privacy");
  return (<>
    <Callout tone="info" title={t("note")} />
    <Field label={t("ipDays")} hint={t("ipHint")}>{(p) => <Input {...p} type="number" min={0} max={3650} value={v.ipAnonymiseDays} onChange={num((n) => set("ipAnonymiseDays", n))} />}</Field>
    <Field label={t("telemetryDays")} hint={t("telemetryHint")}>{(p) => <Input {...p} type="number" min={0} max={3650} value={v.telemetryDays} onChange={num((n) => set("telemetryDays", n))} />}</Field>
  </>);
}

function Security({ v, set }: { v: S; set: (k: string, x: unknown) => void }) {
  const t = useTranslations("settings.security");
  return (<><Toggle label={t("totp")} value={v.requireTotpForAdmins} onChange={(b) => set("requireTotpForAdmins", b)} />
    <Row cols={3}><Field label={t("elevation")}>{(p) => <Input {...p} type="number" min={1} max={60} value={v.elevationMinutes} onChange={num((n) => set("elevationMinutes", n))} />}</Field><Field label={t("session")}>{(p) => <Input {...p} type="number" min={1} max={720} value={v.sessionHours} onChange={num((n) => set("sessionHours", n))} />}</Field><Field label={t("maxUpload")}>{(p) => <Input {...p} type="number" min={1} max={100} value={v.maxUploadMb} onChange={num((n) => set("maxUploadMb", n))} />}</Field></Row></>);
}

function Branding() {
  const t = useTranslations("settings.branding");
  const s = useTranslations("settings");
  const toast = useToast();
  const { me, reload: reloadMe } = useMe();
  const { data, reload } = useApi<{ displayName: string; supportEmail: string; supportPhone: string; signingPageTagline: string; emailFooter: string; logoObjectId: string | null }>("/api/settings/branding");
  const [v, setV] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { if (data && !v) setV(data); }, [data, v]);
  if (!v || !data) return <Skeleton className="h-96" />;
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const save = async () => { setBusy(true); setErr(null); try { await api("/api/settings/branding", { method: "PATCH", json: { displayName: v.displayName, supportEmail: v.supportEmail, supportPhone: v.supportPhone, signingPageTagline: v.signingPageTagline, emailFooter: v.emailFooter } }); toast("ok", s("saved")); await reload(); await reloadMe(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const upload = async (f?: File) => { if (!f) return; try { const form = new FormData(); form.set("file", f); await api("/api/settings/logo", { form }); toast("ok", t("logoSaved")); setRev((n) => n + 1); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  const remove = async () => { try { await api("/api/settings/logo", { method: "DELETE" }); setRev((n) => n + 1); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <Card><CardHeader title={s("sections.branding")} />
      <form className="space-y-5 p-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div><p className="mb-2 text-sm font-medium">{t("logo")}</p>
          <div className="flex flex-wrap items-center gap-4"><div className="grid h-16 w-40 place-items-center rounded-xl bg-[var(--color-12)] p-2">{data.logoObjectId ? <img src={`/api/branding/logo/${me.activeOrganisationId}?r=${rev}`} alt="" className="max-h-12 max-w-full object-contain" /> : <span className="px-2 text-center text-[10px] text-[var(--color-2)]">{t("noLogo")}</span>}</div>
            <input ref={file} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label={t("upload")} onChange={(e) => upload(e.target.files?.[0])} /><Button onClick={() => file.current?.click()}>{t("upload")}</Button>{data.logoObjectId && <Button onClick={remove}>{t("remove")}</Button>}</div>
          <p className="mt-2 text-xs text-muted">{t("logoHint")}</p></div>
        <Field label={t("displayName")} hint={t("displayNameHint")}>{(p) => <Input {...p} value={v.displayName} maxLength={120} onChange={(e) => set("displayName", e.target.value)} />}</Field>
        <Row><Field label={t("supportEmail")}>{(p) => <Input {...p} type="email" dir="ltr" value={v.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} />}</Field><Field label={t("supportPhone")}>{(p) => <Input {...p} type="tel" dir="ltr" value={v.supportPhone} onChange={(e) => set("supportPhone", e.target.value)} />}</Field></Row>
        <Field label={t("tagline")}>{(p) => <Input {...p} value={v.signingPageTagline} maxLength={200} onChange={(e) => set("signingPageTagline", e.target.value)} />}</Field>
        <Field label={t("footer")}>{(p) => <Textarea {...p} value={v.emailFooter} maxLength={1000} onChange={(e) => set("emailFooter", e.target.value)} />}</Field>
        {err && <Callout tone="warn" title={err} />}
        <div className="flex justify-end border-t border-line pt-4"><Button type="submit" variant="primary" loading={busy}>{s("save")}</Button></div>
      </form></Card>
  );
}

type TplRow = { key: string; locale: string; customized: boolean; enabled: boolean; subject: string };
function EmailTemplates() {
  const t = useTranslations("settings.templates");
  const c = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { data, reload } = useApi<{ variables: string[]; items: TplRow[] }>("/api/email-templates");
  const [lang, setLang] = useState(locale);
  const [edit, setEdit] = useState<{ key: string } | null>(null);
  const [f, setF] = useState<{ subject: string; body: string; enabled: boolean; allowed: string[]; customized: boolean } | null>(null);
  const [preview, setPreview] = useState<{ html: string | null; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = data?.items.filter((i) => i.locale === lang) ?? [];
  const open = async (key: string) => {
    setEdit({ key }); setF(null); setPreview(null);
    const r = await api<{ subject: string; body: string; enabled: boolean; allowedVariables: string[]; customized: boolean }>(`/api/email-templates/${key}?locale=${lang}`);
    setF({ subject: r.subject, body: r.body, enabled: r.enabled, allowed: r.allowedVariables, customized: r.customized });
  };
  useEffect(() => {
    if (!edit || !f) return;
    const h = setTimeout(async () => { try { const r = await api<{ html: string | null; problems: string[] }>(`/api/email-templates/${edit.key}`, { json: { locale: lang, subject: f.subject, body: f.body } }); setPreview(r); } catch (e) { setPreview({ html: null, problems: [errMsg(e)] }); } }, 500);
    return () => clearTimeout(h);
  }, [edit, f, lang]);
  const save = async () => { if (!edit || !f || !(await ensure())) return; setBusy(true); try { await api(`/api/email-templates/${edit.key}`, { method: "PUT", json: { locale: lang, subject: f.subject, body: f.body, enabled: f.enabled } }); toast("ok", t("saved")); setEdit(null); await reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  const reset = async () => { if (!edit || !(await ensure())) return; try { await api(`/api/email-templates/${edit.key}?locale=${lang}`, { method: "DELETE" }); toast("ok", t("resetDone")); setEdit(null); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <Card><CardHeader title={t("sub")} action={<Select aria-label={t("language")} value={lang} onChange={(e) => setLang(e.target.value)} className="w-auto"><option value="en">English</option><option value="fa">فارسی</option></Select>} />
      {!data ? <div className="p-5"><Skeleton className="h-40" /></div> : (
        <ul className="divide-y divide-line">{rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-3 px-5 py-3.5"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{t(`names.${r.key}` as never)}</p><p className="truncate text-xs text-muted" dir={lang === "fa" ? "rtl" : "ltr"}>{r.subject}</p></div>
            <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs">{r.customized ? t("customised") : t("default")}</span><Button size="sm" onClick={() => open(r.key)}>{t("edit")}</Button></li>))}</ul>)}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? t(`names.${edit.key}` as never) : ""} size="xl" footer={<>{f?.customized && <Button className="me-auto" onClick={reset}>{t("reset")}</Button>}<Button onClick={() => setEdit(null)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!f || !!preview?.problems.length} onClick={save}>{c("save")}</Button></>}>
        {!f ? <Skeleton className="h-64" /> : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-4">
              <Field label={t("subject")}>{(p) => <Input {...p} value={f.subject} dir={lang === "fa" ? "rtl" : "ltr"} onChange={(e) => setF({ ...f, subject: e.target.value })} />}</Field>
              <Field label={t("body")}>{(p) => <Textarea {...p} rows={12} dir={lang === "fa" ? "rtl" : "ltr"} className="font-mono text-xs" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>
              <Checkbox label={t("disabled")} checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              <div><p className="mb-1 text-xs font-medium text-muted">{t("vars")}</p><p className="flex flex-wrap gap-1.5">{f.allowed.map((v) => <code key={v} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs" dir="ltr">{`{{${v}}}`}</code>)}</p></div>
              {preview?.problems.length ? <Callout tone="warn" title={preview.problems.join(". ")} /> : null}
            </div>
            <div><p className="mb-1 text-xs font-medium text-muted">{t("preview")}</p>{preview?.html ? <iframe title={t("preview")} sandbox="" srcDoc={preview.html} className="h-[28rem] w-full rounded-xl border border-line bg-white" /> : <Skeleton className="h-[28rem]" />}</div>
          </div>)}
      </Modal>
    </Card>
  );
}
void useT;
