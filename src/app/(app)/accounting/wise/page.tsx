"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownLeft, ArrowUpRight, Banknote, Bot, Copy, Download, EyeOff, Landmark, RefreshCw, RotateCcw, Unplug } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Money } from "@/components/accounting/kit";
import { PaymentDialog, type PaymentPrefill } from "@/components/accounting/forms";
import { PaymentAgentDialog } from "@/components/accounting/payment-agent";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { toDecimalString } from "@/lib/money";

type Status = { connected: false } | { connected: true; tokenHint: string | null; profileId: string | null; profileName: string | null; publicKey: string | null; balances: Array<{ id: string; currency: string; amount: number }>; status: string; statementsOk: boolean; lastSyncAt: string | null; lastError: string | null; toRecord: number; total: number };
type Tx = { id: string; wiseId: string; direction: "IN" | "OUT"; kind: string; status: string | null; occurredAt: string; amount: number; currency: string; sourceAmount: number | null; sourceCurrency: string | null; fee: number | null; counterparty: string | null; reference: string | null; description: string | null; organiserPaymentId: string | null; paymentOrganiserId: string | null; paymentOrganiserName: string | null; suggestedOrganiserId: string | null; suggestedName: string | null; stripePayoutId: string | null; ignored: boolean; ignoredReason: string | null };
const VIEWS = ["torecord", "out", "in", "ignored", "all"] as const;

export default function WisePage() {
  const t = useTranslations("accounting.wise");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const st = useApi<Status>("/api/accounting/wise");
  const [view, setView] = useState<(typeof VIEWS)[number]>("torecord"); const [page, setPage] = useState(1); const [q, setQ] = useState("");
  const list = useApi<{ items: Tx[]; total: number; page: number; pageSize: number }>(st.data?.connected ? `/api/accounting/wise/transactions?view=${view}&page=${page}&pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ""}` : null);
  const [token, setToken] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false); const [disc, setDisc] = useState(false);
  const [rec, setRec] = useState<{ tx: Tx; prefill: PaymentPrefill } | null>(null);
  const [agentText, setAgentText] = useState<string | null>(null); const [agentBusy, setAgentBusy] = useState(false);
  const [ign, setIgn] = useState<Tx | null>(null); const [reason, setReason] = useState("");
  const admin = can("accounting.admin"), manage = can("accounting.manage");
  const reloadAll = async () => { await Promise.all([st.reload(), list.reload()]); };

  const connect = async () => {
    if (!(await ensure())) return;
    setBusy(true); setErr(null);
    try { await api("/api/accounting/wise", { json: { token } }); setToken(""); toast("ok", t("connected")); await st.reload(); await sync(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const sync = async () => {
    setSyncing(true);
    try { const r = await api<{ transfers: number; statementLines: number; statementsOk: boolean; error: string | null }>("/api/accounting/wise/sync", { method: "POST" }); toast("ok", t("synced", { transfers: r.transfers, lines: r.statementLines })); }
    catch (e) { toast("error", errMsg(e)); } finally { setSyncing(false); await reloadAll(); }
  };
  const record = (tx: Tx) => setRec({ tx, prefill: { amount: tx.amount, currency: tx.currency, paymentDate: tx.occurredAt.slice(0, 10), bankReference: `Wise #${tx.wiseId.replace(/^TRANSFER-/, "")}`, method: "BANK_TRANSFER", notes: [`Wise transfer to ${tx.counterparty ?? "recipient"}`, tx.reference ? `reference “${tx.reference}”` : null, tx.sourceCurrency && tx.sourceCurrency !== tx.currency && tx.sourceAmount != null ? `debited ${toDecimalString(tx.sourceAmount, tx.sourceCurrency)} ${tx.sourceCurrency.toUpperCase()}` : null, tx.fee ? `Wise fee ${toDecimalString(tx.fee, tx.sourceCurrency ?? tx.currency)} ${(tx.sourceCurrency ?? tx.currency).toUpperCase()} borne by Bilit` : null].filter(Boolean).join(", ") } });
  // AI check: hand every Wise transfer that is not in the books to the AI bookkeeper, which matches organisers and checks balances/duplicates.
  const aiCheck = async () => {
    setAgentBusy(true);
    try {
      const r = await api<{ items: Tx[] }>("/api/accounting/wise/transactions?view=torecord&pageSize=30");
      if (!r.items.length) { toast("ok", t("emptyToRecord")); return; }
      const fmt = (v: number, cur: string) => `${toDecimalString(v, cur)} ${cur.toUpperCase()}`;
      setAgentText([t("aiIntro"), ...r.items.map((x) => `- Wise transfer #${x.wiseId.replace(/^TRANSFER-/, "")}, sent ${x.occurredAt.slice(0, 10)}, to “${x.counterparty ?? "unknown recipient"}”, recipient received ${fmt(x.amount, x.currency)}${x.sourceCurrency && x.sourceCurrency !== x.currency && x.sourceAmount != null ? ` (Bilit paid ${fmt(x.sourceAmount, x.sourceCurrency)})` : ""}${x.fee ? `, Wise fee ${fmt(x.fee, x.sourceCurrency ?? x.currency)}` : ""}, payment reference: ${x.reference ? `“${x.reference}”` : "none"}, status ${x.status ?? "unknown"}. Use bank reference "Wise #${x.wiseId.replace(/^TRANSFER-/, "")}".`)].join("\n"));
    } catch (e) { toast("error", errMsg(e)); } finally { setAgentBusy(false); }
  };
  const copyKey = async (k: string) => { try { await navigator.clipboard.writeText(k); toast("ok", t("copied")); } catch { toast("error", t("copyFailed")); } };

  if (!st.data) return <Skeleton className="h-64" />;
  const s = st.data;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={s.connected && manage ? <><Button loading={agentBusy} disabled={!s.toRecord} onClick={aiCheck}><Bot className="size-4" aria-hidden />{t("aiCheck")}</Button><Button variant="primary" loading={syncing} onClick={sync}><RefreshCw className="size-4" aria-hidden />{t("syncNow")}</Button></> : null} />
      {!s.connected ? (
        <Card><CardHeader title={t("connectTitle")} description={t("connectDesc")} />
          <div className="space-y-4 p-5">
            <ol className="list-decimal space-y-1.5 ps-5 text-sm">
              <li>{t("step1")}</li><li>{t("step2")}</li><li>{t("step3")}</li>
            </ol>
            {admin ? <>
              <Field label={t("token")} hint={t("tokenHint")}>{(p) => <Input {...p} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />}</Field>
              {err && <Callout tone="warn">{err}</Callout>}
              <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={token.trim().length < 20} onClick={connect}><Landmark className="size-4" aria-hidden />{t("connect")}</Button></div>
            </> : <Callout>{t("adminOnly")}</Callout>}
            <p className="text-xs text-muted">{t("readOnlyNote")}</p>
          </div>
        </Card>
      ) : <>
        <Card><CardHeader title={s.profileName ?? t("title")} description={t("connInfo", { hint: s.tokenHint ?? "—", when: s.lastSyncAt ? fmtDate(s.lastSyncAt, locale, { dateStyle: "medium", timeStyle: "short" }) : t("never") })}
          action={admin ? <Button size="sm" variant="ghost" onClick={async () => { if (await ensure()) setDisc(true); }}><Unplug className="size-4" aria-hidden />{t("disconnect")}</Button> : null} />
          <div className="space-y-4 p-5">
            {s.balances.length > 0 && <div className="flex flex-wrap gap-3">{s.balances.map((b) => <div key={b.id} className="rounded-xl border border-line px-4 py-2.5"><p className="text-xs uppercase text-muted">{b.currency}</p><Money v={b.amount} c={b.currency} strong className="text-lg" /></div>)}</div>}
            {s.status === "ERROR" && s.lastError && <Callout tone="warn" title={t("syncError")}>{s.lastError}</Callout>}
            {s.toRecord > 0 && <Callout tone="warn" title={t("toRecordTitle", { n: s.toRecord })}>{t("toRecordDesc")}</Callout>}
            {!s.statementsOk && s.publicKey && <div className="space-y-2 rounded-xl border border-line-strong bg-surface-2 p-4 text-sm">
              <p className="font-medium">{t("scaTitle")}</p>
              <p className="text-muted">{t("scaDesc")}</p>
              {s.lastSyncAt && s.lastError && s.status !== "ERROR" && <p className="text-xs">{s.lastError}</p>}
              <pre className="scroll-thin max-h-40 overflow-auto rounded-lg bg-surface p-3 font-mono text-[11px] leading-snug">{s.publicKey}</pre>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => { const u = URL.createObjectURL(new Blob([s.publicKey!], { type: "application/x-pem-file" })); const a = document.createElement("a"); a.href = u; a.download = "bilit-wise-public-key.pem"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }}><Download className="size-4" aria-hidden />{t("downloadKey")}</Button>
                <Button size="sm" onClick={() => copyKey(s.publicKey!)}><Copy className="size-4" aria-hidden />{t("copyKey")}</Button>
              </div>
            </div>}
            {s.statementsOk && <p className="text-sm text-muted">{t("scaOk")}</p>}
          </div>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div className="flex flex-wrap gap-1.5">{VIEWS.map((v) => <button key={v} type="button" onClick={() => { setView(v); setPage(1); }} aria-pressed={view === v} className={`rounded-full border px-3 py-1 text-sm ${view === v ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg"}`}>{t(`view.${v}`)}{v === "torecord" && s.toRecord ? ` (${s.toRecord})` : ""}</button>)}</div>
            <Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-56" />
          </div>
          {list.loading && !list.data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !list.data?.items.length ? <EmptyState title={t(view === "torecord" ? "emptyToRecord" : "empty")} description={t("emptyDesc")} /> : <>
            <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("counterparty")}</Th><Th>{t("reference")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("match")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
              <tbody>{list.data.items.map((x) => <Tr key={x.id} className={x.ignored ? "text-muted" : ""}>
                <Td className="whitespace-nowrap">{fmtDate(x.occurredAt, locale, { dateStyle: "medium" })}<span className="block text-xs text-muted">{x.kind.toLowerCase()}{x.status && x.status !== "completed" ? ` · ${x.status.replaceAll("_", " ")}` : ""}</span></Td>
                <Td className="min-w-44"><span className="inline-flex items-center gap-1.5 font-medium">{x.direction === "OUT" ? <ArrowUpRight className="size-4 shrink-0" aria-label={t("out")} /> : <ArrowDownLeft className="size-4 shrink-0" aria-label={t("in")} />}{x.counterparty ?? x.description ?? "—"}</span><code className="block text-xs text-muted">{x.wiseId.split(":")[0]}</code></Td>
                <Td className="max-w-56 truncate text-sm" title={x.reference ?? ""}>{x.reference ?? "—"}</Td>
                <Td className="text-end"><Money v={x.direction === "OUT" ? -x.amount : x.amount} c={x.currency} strong />
                  {x.sourceCurrency && x.sourceCurrency !== x.currency && x.sourceAmount != null && <span className="block text-xs text-muted"><Money v={x.sourceAmount} c={x.sourceCurrency} /></span>}
                  {x.fee ? <span className="block text-xs text-muted">{t("fee")} <Money v={x.fee} c={x.sourceCurrency ?? x.currency} /></span> : null}</Td>
                <Td className="min-w-44 text-sm">
                  {x.organiserPaymentId ? <span>{t("recordedFor")} <Link href={`/accounting/organisers/${x.paymentOrganiserId}?tab=payments`} className="font-medium underline-offset-4 hover:underline">{x.paymentOrganiserName}</Link></span>
                    : x.stripePayoutId ? <span>{t("stripePayout")} <code className="text-xs">{x.stripePayoutId}</code></span>
                    : x.ignored ? <span>{t("ignoredAs", { reason: x.ignoredReason ?? "" })}</span>
                    : x.direction === "OUT" && x.kind === "TRANSFER" ? <span className="text-muted">{x.suggestedName ? t("suggested", { name: x.suggestedName }) : t("notRecorded")}</span> : <span className="text-muted">—</span>}
                </Td>
                <Td className="text-end"><div className="flex justify-end gap-1">
                  {manage && !x.organiserPaymentId && !x.ignored && x.direction === "OUT" && x.kind === "TRANSFER" && <Button size="sm" variant="primary" onClick={() => record(x)}><Banknote className="size-3.5" aria-hidden />{t("record")}</Button>}
                  {manage && !x.organiserPaymentId && !x.ignored && <Button size="sm" variant="ghost" onClick={() => { setReason(""); setIgn(x); }} aria-label={t("ignore")} title={t("ignore")}><EyeOff className="size-3.5" aria-hidden /></Button>}
                  {manage && x.ignored && <Button size="sm" variant="ghost" onClick={async () => { try { await api(`/api/accounting/wise/transactions/${x.id}/ignore`, { json: { ignored: false } }); await reloadAll(); } catch (e) { toast("error", errMsg(e)); } }} aria-label={t("unignore")} title={t("unignore")}><RotateCcw className="size-3.5" aria-hidden /></Button>}
                </div></Td></Tr>)}</tbody></Table></TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} /></>}
        </Card>
        <p className="text-xs text-muted">{t("liveNote")}</p>
      </>}

      {agentText && <PaymentAgentDialog open onClose={() => setAgentText(null)} onSaved={() => void reloadAll()} initialText={agentText} autoRun forceMode="live" />}
      {rec && <PaymentDialog open onClose={() => setRec(null)} onSaved={() => void reloadAll()} mode="live" organiserId={rec.tx.suggestedOrganiserId ?? undefined} prefill={rec.prefill} />}
      <ConfirmDialog open={!!ign} onClose={() => setIgn(null)} title={t("ignoreTitle")} description={t("ignoreDesc")} confirmLabel={t("ignore")}
        onConfirm={async () => { try { await api(`/api/accounting/wise/transactions/${ign!.id}/ignore`, { json: { ignored: true, reason } }); await reloadAll(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("ignoreReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ignorePlaceholder")} />}</Field>
      </ConfirmDialog>
      <ConfirmDialog open={disc} onClose={() => setDisc(false)} title={t("disconnectTitle")} description={t("disconnectDesc")} confirmLabel={t("disconnect")}
        onConfirm={async () => { try { await api("/api/accounting/wise", { method: "DELETE" }); toast("ok", t("disconnected")); await st.reload(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
      </ConfirmDialog>
    </div>
  );
}
