"use client";
import { use, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle2, CreditCard, Loader2 } from "lucide-react";
import { Field, Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useTranslations("treasury.staff.invite");
  const tb = useTranslations("treasury.staff");
  const [pw, setPw] = useState(""); const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw !== confirm) { setErr(t("mismatch")); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/staff/treasury/accept-invite/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
      if (!res.ok) { const j = await res.json().catch(() => null); setErr(j?.error?.message ?? t("expired")); return; }
      setDone(true);
    } catch { setErr(t("expired")); } finally { setBusy(false); }
  };
  return (
    <div className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3"><span className="grid size-11 place-items-center rounded-2xl bg-fg text-bg"><CreditCard className="size-5" aria-hidden /></span><div><p className="text-lg font-semibold tracking-tight">{tb("brand")}</p><p className="text-sm text-muted">{tb("tagline")}</p></div></div>
        {done ? (
          <div className="rounded-2xl border border-line bg-surface p-6 text-center"><CheckCircle2 className="mx-auto mb-3 size-10 text-fin-pos" aria-hidden /><p className="font-medium">{t("done")}</p><Link href="/staff/treasury/login" className="mt-4 inline-block font-medium text-fg underline underline-offset-4">{t("toLogin")}</Link></div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("sub")}</p>
            <form onSubmit={submit} className="mt-6 space-y-4">
              <Field label={t("password")} hint={t("hint")}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} />}</Field>
              <Field label={t("confirm")}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}</Field>
              {err && <Callout tone="warn">{err}</Callout>}
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{t("submit")}</Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
