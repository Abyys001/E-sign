"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, Mail, MessageSquareText, ShieldCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { ApiError, api, errMsg } from "@/lib/api";

type Method = "EMAIL_OTP" | "SMS_OTP" | "PASSCODE" | "ACCOUNT";
export function VerifyStep({ token, method, emailHint, onVerified }: { token: string; method: Method; emailHint: string; onVerified: () => void }) {
  const t = useTranslations("signing.verify");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cool, setCool] = useState(0);
  useEffect(() => { if (cool <= 0) return; const i = setTimeout(() => setCool((c) => c - 1), 1000); return () => clearTimeout(i); }, [cool]);
  const otp = method === "EMAIL_OTP" || method === "SMS_OTP";
  const send = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ sentTo: string; cooldownSeconds: number }>(`/api/sign/${token}/otp`, { method: "POST", json: {} }); setSentTo(r.sentTo); setCool(r.cooldownSeconds); setCode(""); }
    catch (e) { if (e instanceof ApiError && e.status === 429) { const s = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds; if (s) setCool(s); } setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  const verify = async (e?: React.FormEvent) => {
    e?.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api<{ verified: boolean; attemptsLeft?: number }>(`/api/sign/${token}/verify`, { json: method === "ACCOUNT" ? {} : { code } });
      if (r.verified) { onVerified(); return; }
      setErr(method === "PASSCODE" ? t("wrongPasscode") : r.attemptsLeft === 0 ? t("locked") : t("wrong", { left: r.attemptsLeft ?? 0 }));
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const Icon = method === "EMAIL_OTP" ? Mail : method === "SMS_OTP" ? MessageSquareText : method === "PASSCODE" ? KeyRound : UserCheck;
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <div className="rise rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
        <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft"><ShieldCheck className="size-6" aria-hidden /></span>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("sub")}</p>
        <div className="mt-6 space-y-4">
          {otp && !sentTo && <><p className="flex items-start gap-2 text-sm"><Icon className="mt-0.5 size-4 shrink-0" aria-hidden />{method === "EMAIL_OTP" ? t("emailOtp", { to: emailHint }) : t("smsOtp")}</p><Button variant="primary" size="lg" className="w-full" loading={busy} disabled={cool > 0} onClick={send}>{cool > 0 ? t("resendIn", { s: cool }) : t("sendCode")}</Button></>}
          {otp && sentTo && (
            <form onSubmit={verify} className="space-y-4">
              <Callout tone="ok" title={t("sent", { to: sentTo })} />
              <Field label={t("code")} error={err}>{(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus dir="ltr" className="h-14 text-center text-2xl tracking-[0.5em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}</Field>
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={code.length !== 6}>{t("verify")}</Button>
              <button type="button" onClick={send} disabled={cool > 0 || busy} className="w-full text-center text-sm underline underline-offset-4 disabled:no-underline disabled:opacity-60">{cool > 0 ? t("resendIn", { s: cool }) : t("resend")}</button>
            </form>
          )}
          {method === "PASSCODE" && (
            <form onSubmit={verify} className="space-y-4"><p className="text-sm text-muted">{t("passcodeSub")}</p>
              <Field label={t("passcode")} error={err}>{(p) => <Input {...p} type="password" autoComplete="off" autoFocus className="h-12" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!code}>{t("verify")}</Button></form>
          )}
          {method === "ACCOUNT" && (<div className="space-y-3"><p className="text-sm">{t("accountSub", { to: emailHint })}</p><a href="/login" target="_blank" rel="noreferrer" className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-line-strong text-sm font-medium hover:bg-surface-2">{t("signIn")}</a><Button variant="primary" size="lg" className="w-full" loading={busy} onClick={() => verify()}>{t("iSignedIn")}</Button>{err && <p role="alert" className="text-sm">⚠ {err}</p>}</div>)}
          {otp && !sentTo && err && <p role="alert" className="text-sm">⚠ {err}</p>}
        </div>
      </div>
    </div>
  );
}
