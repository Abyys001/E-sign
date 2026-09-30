"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useMe } from "@/components/app/me";
import { api, errMsg } from "@/lib/api";

export type RecipientDto = { id: string; name: string; email: string; phone: string | null; company: string | null; role: string; status: string; signingOrder: number; required: boolean; internal: boolean; authLevel: string; hasPasscode: boolean; smsConsent: boolean; viewedAt: string | null; completedAt: string | null; declinedAt: string | null; declineReason: string | null };
type Form = { name: string; email: string; phone: string; company: string; role: string; signingOrder: number; required: boolean; internal: boolean; authLevel: string; passcode: string; smsConsent: boolean };
const blank = (order: number, auth: string): Form => ({ name: "", email: "", phone: "", company: "", role: "SIGNER", signingOrder: order, required: true, internal: false, authLevel: auth, passcode: "", smsConsent: false });

export function RecipientModal({ open, onClose, contractId, existing, nextOrder, parallel, onSaved }: { open: boolean; onClose: () => void; contractId: string; existing: RecipientDto | null; nextOrder: number; parallel: boolean; onSaved: () => void }) {
  const t = useTranslations("contracts.detail.recipients");
  const c = useTranslations("common");
  const { me } = useMe();
  const [f, setF] = useState<Form>(blank(nextOrder, me.settings.signing.defaultAuthLevel));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setF(existing ? { name: existing.name, email: existing.email, phone: existing.phone ?? "", company: existing.company ?? "", role: existing.role, signingOrder: existing.signingOrder, required: existing.required, internal: existing.internal, authLevel: existing.authLevel, passcode: "", smsConsent: existing.smsConsent } : blank(parallel ? 1 : nextOrder, me.settings.signing.defaultAuthLevel));
  }, [open, existing, nextOrder, parallel, me.settings.signing.defaultAuthLevel]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const cc = f.role === "CC";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const payload = { name: f.name, email: f.email, phone: f.phone || null, company: f.company || null, role: f.role, signingOrder: f.signingOrder, required: cc ? false : f.required, internal: f.internal, authLevel: cc ? "LINK" : f.authLevel, passcode: f.authLevel === "PASSCODE" && f.passcode ? f.passcode : undefined, smsConsent: f.smsConsent };
    try {
      if (existing) await api(`/api/contracts/${contractId}/recipients/${existing.id}`, { method: "PATCH", json: payload });
      else await api(`/api/contracts/${contractId}/recipients`, { json: payload });
      onSaved(); onClose();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? t("edit") : t("add")} size="lg"
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name || !f.email || (f.authLevel === "PASSCODE" && !existing?.hasPasscode && !f.passcode)} onClick={(e) => submit(e as never)}>{c("save")}</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")} required>{(p) => <Input {...p} value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={120} />}</Field>
          <Field label={t("email")} required>{(p) => <Input {...p} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />}</Field>
          <Field label={t("company")}>{(p) => <Input {...p} value={f.company} onChange={(e) => set("company", e.target.value)} />}</Field>
          <Field label={t("phone")}>{(p) => <Input {...p} type="tel" dir="ltr" placeholder="+447700900123" value={f.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
          <Field label={t("role")}>{(p) => <Select {...p} value={f.role} onChange={(e) => set("role", e.target.value)}>{["SIGNER", "WITNESS", "APPROVER", "CC"].map((r) => <option key={r} value={r}>{c(`roles.${r}`)}</option>)}</Select>}</Field>
          {!parallel && <Field label={t("order")}>{(p) => <Input {...p} type="number" min={1} max={50} value={f.signingOrder} onChange={(e) => set("signingOrder", Math.max(1, Number(e.target.value) || 1))} />}</Field>}
          {!cc && <Field label={t("auth")}>{(p) => <Select {...p} value={f.authLevel} onChange={(e) => set("authLevel", e.target.value)}>{["LINK", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"].filter((a) => a !== "SMS_OTP" || me.settings.sms.enabled).map((a) => <option key={a} value={a}>{c(`auth.${a}`)}</option>)}</Select>}</Field>}
          {f.authLevel === "PASSCODE" && !cc && <Field label={t("passcode")} hint={t("passcodeHint")} required={!existing?.hasPasscode}>{(p) => <Input {...p} type="password" autoComplete="new-password" minLength={4} maxLength={64} value={f.passcode} onChange={(e) => set("passcode", e.target.value)} />}</Field>}
        </div>
        {!cc && <Checkbox label={t("required")} checked={f.required} onChange={(e) => set("required", e.target.checked)} />}
        {(f.authLevel === "SMS_OTP" || f.phone) && <Checkbox label={t("smsConsent")} checked={f.smsConsent} onChange={(e) => set("smsConsent", e.target.checked)} />}
        <Checkbox label={t("internal")} checked={f.internal} onChange={(e) => set("internal", e.target.checked)} />
        {err && <Callout tone="warn" title={err} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
