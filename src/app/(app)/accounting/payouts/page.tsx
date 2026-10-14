"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Landmark, RefreshCw, Send, XCircle } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { AmountCard, Badge, CopyText, Money, useMode } from "@/components/accounting/kit";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";
import { parseMajor, toDecimalString } from "@/lib/money";

type PayeeType = "ORGANISER" | "PARTNER" | "BILL";
type Owed = { currency: string; amount: number };
type Payees = {
  organisers: Array<{ id: string; name: string; recipientId: string | null; owed: Owed[] }>;
  partners: Array<{ id: string; name: string; recipientId: string | null; owed: Owed[] }>;
  bills: Array<{ id: string; name: string; invoiceNumber: string | null; dueDate: string | null; currency: string; amount: number; recipientId: string | null }>;
};
type Balance = { connected: boolean; financialAccount: { id: string; name: string | null; balances: Record<string, number> } | null };
type Payout = { id: string; payeeType: PayeeType; payeeName: string; amount: number; currency: string; toCurrency: string | null; creditedAmount: number | null; feeAmount: number; payoutMethodLabel: string | null; description: string | null; stripeId: string | null; status: string; failure: string | null; verificationResult: string | null; createdAt: string };
type Prep = {
  payee: { name: string; owed: number | null }; available: number; financialAccountId: string;
  quote: { id: string; fees: Array<{ type: string; amount: number; currency: string }>; feeTotal: number; credited: { amount: number; currency: string } | null; rate: string | null; expiresAt: string | null } | null;
  verification: { id: string; result: string; matchedName: string | null; message: string | null } | null;
  warnings: string[];
};

export default function PayoutsPage() {
  const t = useTranslations("accounting.payouts");
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { mode, q } = useMode();
  const params = useSearchParams();
  const bal = useApi<Balance>(q("/api/accounting/payouts/balance"));
  const list = useApi<{ items: Payout[]; total: number }>(q("/api/accounting/payouts?pageSize=100"));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<Payout | null>(null);
  const admin = can("accounting.admin"), manage = can("accounting.manage");
  const preset = useMemo(() => {
    const type = params.get("type") as PayeeType | null;
    return type && ["ORGANISER", "PARTNER", "BILL"].includes(type) ? { type, id: params.get("id") ?? "", currency: params.get("currency") ?? "" } : null;
  }, [params]);
  useEffect(() => { if (preset && admin && bal.data?.connected) setOpen(true); }, [preset, admin, bal.data?.connected]);

  const refresh = async () => {
    setBusy(true);
    try { const r = await api<{ checked: number }>(q("/api/accounting/payouts/sync"), { method: "POST" }); toast("ok", t("refreshed", { n: r.checked })); await Promise.all([list.reload(), bal.reload()]); }
    catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!cancelling || !(await ensure())) return;
    try { await api(`/api/accounting/payouts/${cancelling.id}/cancel`, { method: "POST" }); toast("ok", t("cancelled")); setCancelling(null); await Promise.all([list.reload(), bal.reload()]); }
    catch (e) { toast("error", errMsg(e)); }
  };

  if (bal.error) return <div className="space-y-6"><PageHeader title={t("title")} description={t("sub")} /><Callout tone="warn">{errMsg(bal.error)}</Callout></div>;
  if (!bal.data) return <Skeleton className="h-64" />;
  if (!bal.data.connected) return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} />
      <EmptyState icon={<Landmark className="size-6" aria-hidden />} title={t("notSetUp", { mode: mode.toUpperCase() })} description={t("notSetUpDesc")} action={admin ? <LinkButton href="/accounting/settings#payouts" variant="primary">{t("setUp")}</LinkButton> : undefined} />
    </div>
  );
  const fa = bal.data.financialAccount!;
  const balances = Object.entries(fa.balances);
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        {manage && <Button loading={busy} onClick={refresh}><RefreshCw className="size-4" aria-hidden />{t("refresh")}</Button>}
        {admin && <Button variant="primary" onClick={() => setOpen(true)}><Send className="size-4" aria-hidden />{t("send")}</Button>}
      </>} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {balances.length ? balances.map(([c, v]) => <AmountCard key={c} label={t("available", { c: c.toUpperCase() })} v={v} c={c} tone="bal" icon={Landmark} hint={fa.name ?? fa.id} />)
          : <Callout tone="warn">{t("noBalance")}</Callout>}
      </div>
      <Card><CardHeader title={t("history")} description={t("historyDesc")} />
        {!list.data ? <Skeleton className="m-5 h-32" /> : !list.data.items.length ? <p className="p-5 text-sm text-muted">{t("none")}</p> : (
          <TableWrap><Table>
            <thead><tr><Th>{t("date")}</Th><Th>{t("payee")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("to")}</Th><Th>{t("status")}</Th><Th>{t("stripeRef")}</Th><Th /></tr></thead>
            <tbody>{list.data.items.map((p) => <Tr key={p.id}>
              <Td className="whitespace-nowrap">{new Date(p.createdAt).toLocaleString()}</Td>
              <Td><span className="font-medium">{p.payeeName}</span><span className="block text-xs text-muted">{t(`type.${p.payeeType}`)}{p.description ? ` · ${p.description}` : ""}</span></Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong />{p.toCurrency && p.creditedAmount ? <span className="block text-xs text-muted">→ <Money v={p.creditedAmount} c={p.toCurrency} /></span> : null}</Td>
              <Td className="text-sm">{p.payoutMethodLabel ?? "—"}</Td>
              <Td><Badge s={p.status} />{p.failure && <span className="mt-1 block max-w-64 text-xs text-muted">{p.failure}</span>}</Td>
              <Td>{p.stripeId ? <CopyText text={p.stripeId} /> : "—"}</Td>
              <Td>{admin && p.status === "PROCESSING" && <Button size="sm" variant="ghost" onClick={() => setCancelling(p)}>{t("cancel")}</Button>}</Td>
            </Tr>)}</tbody>
          </Table></TableWrap>
        )}
      </Card>
      <Callout title={t("howTitle")}>{t("how")}</Callout>
      {open && <SendDialog mode={mode} q={q} balances={fa.balances} preset={preset} onClose={() => setOpen(false)} onSent={() => { void list.reload(); void bal.reload(); }} />}
      <ConfirmDialog open={!!cancelling} onClose={() => setCancelling(null)} onConfirm={cancel} title={t("cancelTitle")} description={cancelling ? t("cancelDesc", { name: cancelling.payeeName, amount: `${toDecimalString(cancelling.amount, cancelling.currency)} ${cancelling.currency.toUpperCase()}` }) : ""} confirmLabel={t("cancel")} danger />
    </div>
  );
}

function SendDialog({ mode, q, balances, preset, onClose, onSent }: { mode: string; q: (u: string) => string; balances: Record<string, number>; preset: { type: PayeeType; id: string; currency: string } | null; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("accounting.payouts");
  const c = useTranslations("common");
  const toast = useToast();
  const ensure = useElevation();
  const payees = useApi<Payees>(q("/api/accounting/payouts/payees"));
  const recips = useApi<{ items: Array<{ id: string; name: string; email: string | null; country: string | null }> }>(q("/api/accounting/payouts/recipients"));
  const [type, setType] = useState<PayeeType>(preset?.type ?? "ORGANISER");
  const [payeeId, setPayeeId] = useState(preset?.id ?? "");
  const [currency, setCurrency] = useState(preset?.currency ?? "");
  const [amount, setAmount] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [remember, setRemember] = useState(true);
  const [methodId, setMethodId] = useState("");
  const [toCurrency, setToCurrency] = useState("");
  const [description, setDescription] = useState("");
  const [overpay, setOverpay] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [dupMsg, setDupMsg] = useState<string | null>(null);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const methods = useApi<{ items: Array<{ id: string; type: string; label: string }> }>(recipientId ? q(`/api/accounting/payouts/recipients/${recipientId}/methods`) : null);

  const options = useMemo(() => {
    const d = payees.data; if (!d) return [];
    if (type === "ORGANISER") return d.organisers.map((o) => ({ id: o.id, label: o.name, recipientId: o.recipientId, owed: o.owed }));
    if (type === "PARTNER") return d.partners.map((o) => ({ id: o.id, label: o.name, recipientId: o.recipientId, owed: o.owed }));
    return d.bills.map((b) => ({ id: b.id, label: `${b.name}${b.invoiceNumber ? ` #${b.invoiceNumber}` : ""}${b.dueDate ? ` · due ${b.dueDate}` : ""}`, recipientId: b.recipientId, owed: [{ currency: b.currency, amount: b.amount }] }));
  }, [payees.data, type]);
  const sel = options.find((o) => o.id === payeeId);
  const owed = sel?.owed.find((o) => o.currency === currency) ?? null;
  // defaults follow the chosen payee: its first owed currency, the full amount owed, its linked Stripe recipient
  useEffect(() => { if (!sel) return; const cur = sel.owed.find((o) => o.currency === currency) ?? sel.owed[0]; if (cur && !sel.owed.some((o) => o.currency === currency)) setCurrency(cur.currency); if (cur) setAmount(toDecimalString(cur.amount, cur.currency)); setRecipientId(sel.recipientId ?? ""); setPrep(null); }, [payeeId, sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (methods.data && !methods.data.items.some((m) => m.id === methodId)) setMethodId(methods.data.items[0]?.id ?? ""); }, [methods.data, methodId]);
  useEffect(() => { setPrep(null); setAck(false); }, [type, payeeId, currency, amount, recipientId, methodId, toCurrency, overpay]);

  const input = () => ({ mode, payeeType: type, payeeId, amount: parseMajor(amount, currency || "eur"), currency, recipientId, payoutMethodId: methodId, toCurrency: toCurrency || null, description: description || null, overpay, allowDuplicate });
  const review = async () => {
    setBusy(true); setErr(null); setDupMsg(null);
    try {
      if (remember && type !== "BILL" && recipientId && sel && sel.recipientId !== recipientId) await api("/api/accounting/payouts/recipients", { method: "PUT", json: { payeeType: type, payeeId, recipientId } });
      setPrep(await api<Prep>("/api/accounting/payouts/prepare", { json: input() }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.details as { duplicatePayout?: string } | undefined)?.duplicatePayout) setDupMsg(errMsg(e)); else setErr(errMsg(e));
    } finally { setBusy(false); }
  };
  const send = async () => {
    if (!prep) return;
    setBusy(true); setErr(null);
    try {
      if (!(await ensure())) return;
      const r = await api<{ status: string }>("/api/accounting/payouts", { json: { ...input(), quoteId: prep.quote?.id ?? null, verificationId: prep.verification?.id ?? null, acknowledgeMismatch: ack } });
      toast(r.status === "FAILED" ? "error" : "ok", r.status === "FAILED" ? t("sentFailed") : t("sent"));
      onSent(); onClose();
    } catch (e) { setErr(errMsg(e)); onSent(); } finally { setBusy(false); }
  };

  const mismatch = prep?.verification && prep.verification.result !== "match";
  const ready = !!(payeeId && currency && amount && recipientId && methodId);
  return (
    <Modal open size="lg" onClose={onClose} title={prep ? t("reviewTitle") : t("send")} description={prep ? t("reviewDesc") : t("sendDesc")}
      footer={prep
        ? <><Button onClick={() => setPrep(null)}>{t("back")}</Button><Button variant="primary" loading={busy} disabled={!!mismatch && !ack} onClick={send}><Send className="size-4" aria-hidden />{t("sendNow", { amount: `${toDecimalString(parseMajor(amount, currency), currency)} ${currency.toUpperCase()}` })}</Button></>
        : <><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={review}>{t("review")}</Button></>}>
      {!payees.data ? <Skeleton className="h-48" /> : prep ? (
        <div className="space-y-4">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">{t("payee")}</dt><dd className="font-medium">{prep.payee.name}</dd></div>
            <div><dt className="text-muted">{t("amount")}</dt><dd className="font-medium"><Money v={parseMajor(amount, currency)} c={currency} strong /></dd></div>
            {prep.payee.owed !== null && <div><dt className="text-muted">{t("owed")}</dt><dd><Money v={prep.payee.owed} c={currency} /></dd></div>}
            <div><dt className="text-muted">{t("availableShort")}</dt><dd><Money v={prep.available} c={currency} /></dd></div>
            <div><dt className="text-muted">{t("to")}</dt><dd>{methods.data?.items.find((m) => m.id === methodId)?.label ?? methodId}</dd></div>
            {prep.quote?.credited && <div><dt className="text-muted">{t("theyReceive")}</dt><dd className="font-medium"><Money v={prep.quote.credited.amount} c={prep.quote.credited.currency} strong />{prep.quote.rate ? <span className="block text-xs text-muted">{t("rate", { rate: prep.quote.rate })}</span> : null}</dd></div>}
            {prep.quote && <div><dt className="text-muted">{t("fees")}</dt><dd>{prep.quote.fees.filter((f) => f.amount).length ? prep.quote.fees.filter((f) => f.amount).map((f) => <span key={f.type} className="block"><Money v={f.amount} c={f.currency} /> <span className="text-xs text-muted">{f.type.replace(/_/g, " ")}</span></span>) : t("noFees")}</dd></div>}
          </dl>
          {prep.verification && <Callout tone={mismatch ? "warn" : undefined} title={mismatch ? t("copMismatch") : t("copMatch")}>
            <span className="flex items-start gap-2">{mismatch ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-fin-pos" aria-hidden />}
              <span>{prep.verification.message ?? prep.verification.result.replace(/_/g, " ")}{prep.verification.matchedName ? ` — ${t("bankName", { name: prep.verification.matchedName })}` : ""}</span></span>
          </Callout>}
          {mismatch && <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label={t("ackMismatch")} />}
          {prep.warnings.map((w) => <Callout key={w} tone="warn">{w}</Callout>)}
          <p className="text-xs text-muted">{t("bookNote")}</p>
          {err && <Callout tone="warn">{err}</Callout>}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("payType")}>{(p) => <Select {...p} value={type} onChange={(e) => { setType(e.target.value as PayeeType); setPayeeId(""); }}>{(["ORGANISER", "PARTNER", "BILL"] as const).map((x) => <option key={x} value={x}>{t(`type.${x}`)}</option>)}</Select>}</Field>
          <Field label={t("payee")} required>{(p) => <Select {...p} value={payeeId} onChange={(e) => setPayeeId(e.target.value)}><option value="">{t("choose")}</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.owed.length ? ` — ${o.owed.map((x) => `${toDecimalString(x.amount, x.currency)} ${x.currency.toUpperCase()}`).join(", ")}` : ""}</option>)}</Select>}</Field>
          <Field label={t("amount")} required hint={owed ? t("owedHint", { owed: `${toDecimalString(owed.amount, owed.currency)} ${owed.currency.toUpperCase()}` }) : undefined}>{(p) => <Input {...p} inputMode="decimal" disabled={type === "BILL"} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label={t("currency")} required hint={currency ? t("availableHint", { amount: `${toDecimalString(balances[currency] ?? 0, currency)} ${currency.toUpperCase()}` }) : undefined}>{(p) => <Select {...p} value={currency} disabled={type === "BILL"} onChange={(e) => setCurrency(e.target.value)}><option value="">—</option>{[...new Set([...(sel?.owed.map((o) => o.currency) ?? []), ...Object.keys(balances)])].map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}</Select>}</Field>
          <Field label={t("recipient")} required hint={recips.error ? errMsg(recips.error) : t("recipientHint")}>{(p) => <Select {...p} value={recipientId} onChange={(e) => setRecipientId(e.target.value)}><option value="">{recips.data ? t("choose") : c("loading")}</option>{recips.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}{r.country ? ` (${r.country})` : ""}{r.email ? ` · ${r.email}` : ""}</option>)}</Select>}</Field>
          <Field label={t("method")} required hint={methods.error ? errMsg(methods.error) : recipientId && methods.data && !methods.data.items.length ? t("noMethods") : undefined}>{(p) => <Select {...p} value={methodId} disabled={!recipientId} onChange={(e) => setMethodId(e.target.value)}>{methods.data?.items.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select>}</Field>
          <Field label={t("toCurrency")} hint={t("toCurrencyHint")}>{(p) => <Input {...p} value={toCurrency} maxLength={3} placeholder={currency.toUpperCase()} onChange={(e) => setToCurrency(e.target.value.toLowerCase())} className="uppercase" />}</Field>
          <Field label={t("description")} hint={t("descriptionHint")}>{(p) => <Input {...p} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />}</Field>
          {type !== "BILL" && <div className="space-y-2 sm:col-span-2">
            {sel && recipientId !== (sel.recipientId ?? "") && <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} label={t("remember", { name: sel.label })} />}
            {owed && parseMajor(amount || "0", currency) > owed.amount && <Checkbox checked={overpay} onChange={(e) => setOverpay(e.target.checked)} label={t("overpay")} />}
          </div>}
          {dupMsg && <div className="space-y-2 sm:col-span-2"><Callout tone="warn">{dupMsg}</Callout><Checkbox checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} label={t("allowDuplicate")} /></div>}
          {err && <div className="sm:col-span-2"><Callout tone="warn"><span className="flex items-start gap-2"><XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{err}</span></Callout></div>}
          <p className="text-xs text-muted sm:col-span-2">{t.rich("recipientsAtStripe", { a: (x) => <Link href="https://dashboard.stripe.com/global-payouts/recipients" target="_blank" rel="noreferrer" className="underline">{x}</Link> })}</p>
        </div>
      )}
    </Modal>
  );
}
