"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";
import { Money } from "./kit";

type Tx = { id: string; kind: string; balanceTransactionId: string; amount: number; currency: string; description: string | null; eventCode: string | null; eventId: string | null };
type Ev = { id: string; name: string; code: string; currency: string; status: string; organiserName: string | null; organiserId: string | null };
type Acc = { id: string; code: string; name: string; systemKey: string | null };

/** Assign a Stripe transaction to an event (organiser follows from the event), or classify unclassified Stripe activity. */
export function MatchDialog({ tx, open, onClose, onDone }: { tx: Tx | null; open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("accounting.match");
  const c = useTranslations("common");
  const toast = useToast();
  const classify = tx?.kind === "OTHER";
  const { data: events } = useApi<{ items: Ev[] }>(open && !classify ? "/api/accounting/events?pageSize=200" : null);
  const { data: accounts } = useApi<{ accounts: Acc[] }>(open && classify ? "/api/accounting/accounts" : null);
  const [eventId, setEventId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [needsOverride, setNeedsOverride] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ev = events?.items.find((e) => e.id === eventId);
  const reset = () => { setEventId(""); setAccountId(""); setReason(""); setOverride(false); setNeedsOverride(null); setErr(null); };
  const submit = async () => {
    if (!tx) return;
    setBusy(true); setErr(null);
    try {
      if (classify) await api(`/api/accounting/reconciliation/${tx.id}/classify`, { json: { accountId, reason } });
      else await api(`/api/accounting/reconciliation/${tx.id}/match`, { json: { eventId, reason, override } });
      toast("ok", classify ? t("classified") : t("matched"));
      reset(); onDone(); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "precondition_failed") setNeedsOverride(e.message);
      else setErr(errMsg(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title={classify ? t("classifyTitle") : t("title")} description={t("desc")}
      footer={<><Button onClick={() => { reset(); onClose(); }}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 3 || (classify ? !accountId : !eventId) || (!!needsOverride && !override)} onClick={submit}>{classify ? t("classify") : t("assign")}</Button></>}>
      {tx && <div className="space-y-4">
        <div className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
          <div className="flex items-center justify-between gap-3"><code className="text-xs">{tx.balanceTransactionId}</code><Money v={tx.amount} c={tx.currency} strong /></div>
          {tx.description && <p className="mt-1 text-muted">{tx.description}</p>}
          {tx.eventCode && <p className="mt-1 text-xs">{t("foundCode")}: <code>{tx.eventCode}</code></p>}
        </div>
        {classify ? (
          <Field label={t("account")} required>{(p) => <Select {...p} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">{t("choose")}</option>{accounts?.accounts.filter((a) => !["stripe_balance", "organiser_payable"].includes(a.systemKey ?? "")).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        ) : (
          <Field label={t("event")} required hint={ev ? `${t("organiser")}: ${ev.organiserName ?? t("noOrganiser")}` : undefined}>
            {(p) => <Select {...p} value={eventId} onChange={(e) => { setEventId(e.target.value); setNeedsOverride(null); setOverride(false); }}><option value="">{t("choose")}</option>{events?.items.map((e) => <option key={e.id} value={e.id} disabled={!e.organiserId}>{e.code} · {e.name} ({e.currency.toUpperCase()}){!e.organiserId ? ` — ${t("noOrganiser")}` : ""}</option>)}</Select>}
          </Field>
        )}
        <Field label={t("reason")} required hint={t("reasonHint")}>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />}</Field>
        {needsOverride && <Callout tone="warn" title={t("overrideTitle")}>{needsOverride}<div className="mt-2"><Checkbox label={t("overrideConfirm")} checked={override} onChange={(e) => setOverride(e.target.checked)} /></div></Callout>}
        {err && <Callout tone="warn">{err}</Callout>}
      </div>}
    </Modal>
  );
}
