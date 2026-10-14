"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CreditCard, Loader2 } from "lucide-react";
import { Field, Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";

export default function StaffLoginPage() {
  const t = useTranslations("treasury.staff.login");
  const tb = useTranslations("treasury.staff");
  const router = useRouter();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false); const [sent, setSent] = useState(false);
  const sendReset = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/staff/treasury/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      if (!res.ok && res.status !== 200) { const j = await res.json().catch(() => null); setErr(j?.error?.message ?? t("error")); return; }
      setSent(true);
    } catch { setErr(t("error")); } finally { setBusy(false); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/staff/treasury/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!res.ok) { const j = await res.json().catch(() => null); setErr(j?.error?.message ?? t("error")); return; }
      router.replace("/staff/treasury/dashboard");
    } catch { setErr(t("error")); } finally { setBusy(false); }
  };
  return (
    <div className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-fg text-bg"><CreditCard className="size-5" aria-hidden /></span>
          <div><p className="text-lg font-semibold tracking-tight">{tb("brand")}</p><p className="text-sm text-muted">{tb("tagline")}</p></div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("sub")}</p>
        {forgot ? (
          <form onSubmit={sendReset} className="mt-6 space-y-4">
            <p className="text-sm text-muted">{t("forgotSub")}</p>
            <Field label={t("email")}>{(p) => <Input {...p} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
            {sent && <Callout tone="ok">{t("forgotSent")}</Callout>}
            {err && <Callout tone="warn">{err}</Callout>}
            <Button type="submit" variant="primary" className="w-full" disabled={busy || sent}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{t("forgotSubmit")}</Button>
            <button type="button" className="text-sm text-accent underline" onClick={() => { setForgot(false); setSent(false); setErr(null); }}>{t("backToLogin")}</button>
          </form>
        ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label={t("email")}>{(p) => <Input {...p} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
          <Field label={t("password")}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
          {err && <Callout tone="warn">{err}</Callout>}
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{t("submit")}</Button>
          <button type="button" className="text-sm text-accent underline" onClick={() => { setForgot(true); setErr(null); }}>{t("forgot")}</button>
        </form>
        )}
        <p className="mt-6 text-xs text-muted">{t("footer")}</p>
      </div>
    </div>
  );
}
