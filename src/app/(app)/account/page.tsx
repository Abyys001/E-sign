"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, errMsg } from "@/lib/api";

export default function AccountPage() {
  const t = useTranslations("app.account");
  const c = useTranslations("common");
  const { me, reload } = useMe();
  const ensure = useElevation();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("title")} description={t("sub")} />
      <div className="space-y-6">
        <Card><CardHeader title={t("profile")} /><dl className="grid gap-4 p-5 text-sm sm:grid-cols-2"><div><dt className="text-muted">{c("name")}</dt><dd className="font-medium">{me.user.name}</dd></div><div><dt className="text-muted">{c("email")}</dt><dd className="font-medium">{me.user.email}</dd></div></dl></Card>
        <Card><CardHeader title={t("twofa")} description={me.user.hasTotp ? t("twofaOn") : t("twofaOff")} action={me.user.hasTotp ? <ShieldCheck className="size-5" aria-hidden /> : <ShieldOff className="size-5 text-muted" aria-hidden />} />
          <div className="space-y-4 p-5">
            {!me.user.hasTotp && !setup && <Button variant="primary" loading={busy} onClick={() => run(async () => setSetup(await api("/api/auth/totp")))}>{t("enable")}</Button>}
            {setup && (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/api/auth/totp", { json: { code } }); toast("ok", t("enabled")); setSetup(null); setCode(""); await reload(); }); }}>
                <p className="text-sm text-muted">{t("scan")}</p>
                <div><p className="text-xs text-muted">{t("secret")}</p><code dir="ltr" className="mt-1 block break-all rounded-lg bg-surface-2 p-3 text-sm">{setup.secret}</code><a href={setup.otpauthUri} className="mt-2 inline-block text-xs underline underline-offset-4">otpauth://</a></div>
                <Field label={t("code")} error={err}>{(p) => <Input {...p} inputMode="numeric" maxLength={6} dir="ltr" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}</Field>
                <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>{t("verifyEnable")}</Button>
              </form>
            )}
            {me.user.hasTotp && !off && <Button onClick={() => setOff(true)}>{t("disable")}</Button>}
            {me.user.hasTotp && off && (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/api/auth/totp", { method: "DELETE", json: { password: pw } }); toast("ok", t("disabled")); setOff(false); setPw(""); await reload(); }); }}>
                <Field label={t("confirmPassword")} error={err}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
                <div className="flex gap-2"><Button variant="danger" type="submit" loading={busy} disabled={!pw}>{t("disable")}</Button><Button onClick={() => setOff(false)}>{c("cancel")}</Button></div>
              </form>
            )}
          </div></Card>
        <Card><CardHeader title={t("sessions")} description={t("elevateHint")} action={<KeyRound className="size-5" aria-hidden />} />
          <div className="p-5">{me.elevated ? <Callout tone="ok" title={t("elevated")} /> : <Button onClick={async () => { if (await ensure()) toast("ok", t("elevated")); }}>{t("elevate")}</Button>}</div></Card>
      </div>
    </div>
  );
}
