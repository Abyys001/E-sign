"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Callout } from "@/components/ui/feedback";
import { api, errMsg } from "@/lib/api";

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useTranslations("auth");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api("/api/auth/accept-invite", { json: { token, password: pw } }); setDone(true); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="rise space-y-5">
      <div><h1 className="text-3xl font-semibold tracking-tight">{t("inviteTitle")}</h1><p className="mt-1.5 text-muted">{t("inviteSub")}</p></div>
      {done ? (
        <div className="space-y-4"><Callout tone="ok" icon={<CheckCircle2 className="size-5 shrink-0" aria-hidden />}>{t("passwordUpdated")}</Callout><LinkButton href="/login" variant="primary" size="lg" className="w-full">{t("signIn")}</LinkButton></div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <Field label={t("newPassword")} hint={t("passwordHint")} error={err} required>{(p) => <Input {...p} type="password" autoComplete="new-password" minLength={12} autoFocus required value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={pw.length < 12}>{t("setPassword")}</Button>
        </form>
      )}
      <p className="text-center text-sm"><Link href="/login" className="text-muted underline underline-offset-4 hover:text-fg">{t("backToSignIn")}</Link></p>
    </div>
  );
}
