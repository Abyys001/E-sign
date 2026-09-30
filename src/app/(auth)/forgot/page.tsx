"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Callout } from "@/components/ui/feedback";
import { api, errMsg } from "@/lib/api";

export default function ForgotPage() {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api("/api/auth/forgot", { json: { email } }); setSent(true); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="rise space-y-5">
      <div><h1 className="text-3xl font-semibold tracking-tight">{t("forgotTitle")}</h1><p className="mt-1.5 text-muted">{t("forgotSub")}</p></div>
      {sent ? <Callout tone="ok" icon={<MailCheck className="size-5 shrink-0" aria-hidden />}>{t("sent")}</Callout> : (
        <form onSubmit={submit} className="space-y-5">
          <Field label={t("email")} error={err} required>{(p) => <Input {...p} type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email}>{t("sendLink")}</Button>
        </form>
      )}
      <p className="text-center text-sm"><Link href="/login" className="text-muted underline underline-offset-4 hover:text-fg">{t("backToSignIn")}</Link></p>
    </div>
  );
}
