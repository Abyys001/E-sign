"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { ApiError, api } from "@/lib/api";

export default function LoginPage() {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api("/api/auth/login", { json: { email, password, totp: needTotp ? totp : undefined } }); window.location.href = "/dashboard"; }
    catch (x) {
      if (x instanceof ApiError && (x.details as { totpRequired?: boolean } | undefined)?.totpRequired) setNeedTotp(true);
      setErr(x instanceof ApiError ? x.message : t("invalidLink"));
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="rise space-y-5" noValidate>
      <div><h1 className="text-3xl font-semibold tracking-tight">{t("signInTitle")}</h1><p className="mt-1.5 text-muted">{t("signInSub")}</p></div>
      <Field label={t("email")} required>{(p) => <Input {...p} type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label={t("password")} required>{(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      {needTotp && <Field label={t("totp")} hint={t("totpHint")} required>{(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />}</Field>}
      {err && <p role="alert" className="rounded-xl border-2 border-fg px-3.5 py-2.5 text-sm">⚠ {err}</p>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || !password}>{busy ? t("signingIn") : t("signIn")}</Button>
      <p className="text-center text-sm"><Link href="/forgot" className="text-muted underline underline-offset-4 hover:text-fg">{t("forgot")}</Link></p>
    </form>
  );
}
