"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownLeft, ArrowUpRight, Banknote, Bot, FileText, HandCoins, Receipt, EyeOff, Landmark, RefreshCw, RotateCcw, Settings } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Money } from "@/components/accounting/kit";
import { PaymentDialog, type PaymentPrefill } from "@/components/accounting/forms";
import { PaymentAgentDialog } from "@/components/accounting/payment-agent";
import { WiseBalances } from "@/components/accounting/wise-settings";
import { BillDialog, useExpenseAccounts, type BillPrefill } from "@/components/accounting/books";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { toDecimalString } from "@/lib/money";

type Status = { connected: false } | { connected: true; tokenHint: string | null; profileId: string | null; profileName: string | null; publicKey: string | null; balances: Array<{ id: string; currency: string; amount: number }>; status: string; statementsOk: boolean; lastSyncAt: string | null; lastError: string | null; toRecord: number; total: number };
type Tx = { id: string; wiseId: string; direction: "IN" | "OUT"; kind: string; status: string | null; occurredAt: string; amount: number; currency: string; sourceAmount: number | null; sourceCurrency: string | null; fee: number | null; counterparty: string | null; reference: string | null; description: string | null; organiserPaymentId: string | null; paymentOrganiserId: string | null; paymentOrganiserName: string | null; suggestedOrganiserId: string | null; suggestedName: string | null; stripePayoutId: string | null; ignored: boolean; ignoredReason: string | null; billId: string | null; billKind: string | null; billSupplier: string | null; partnerPaymentId: string | null; partnerName: string | null; refNumber: string };
const VIEWS = ["torecord", "spend", "out", "in", "ignored", "all"] as const;

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
  const [syncing, setSyncing] = useState(false);
  const [rec, setRec] = useState<{ tx: Tx; prefill: PaymentPrefill } | null>(null);
  const [bill, setBill] = useState<{ kind: "BILL" | "EXPENSE"; prefill: BillPrefill } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<"expense" | "bill" | "organiser" | "partner" | "ignore" | null>(null);
  const [bulkV, setBulkV] = useState({ accountId: "", organiserId: "", partnerId: "", reason: "" }); const [bulkBusy, setBulkBusy] = useState(false); const [bulkErr, setBulkErr] = useState<string | null>(null);
  const accounts = useExpenseAccounts();
  const partnersL = useApi<{ items: Array<{ id: string; name: string; sharePercent: number }> }>(bulk === "partner" ? "/api/accounting/profit-share/partners" : null);
  const orgs = useApi<{ items: Array<{ id: string; name: string }> }>(bulk === "organiser" ? "/api/accounting/organisers?pageSize=200" : null);
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
  const record = (tx: Tx) => setRec({ tx, prefill: { amount: tx.amount, currency: tx.currency, paymentDate: tx.occurredAt.slice(0, 10), bankReference: `Wise #${tx.refNumber}`, method: "BANK_TRANSFER", notes: [`Wise transfer to ${tx.counterparty ?? "recipient"}`, tx.reference ? `reference “${tx.reference}”` : null, tx.sourceCurrency && tx.sourceCurrency !== tx.currency && tx.sourceAmount != null ? `debited ${toDecimalString(tx.sourceAmount, tx.sourceCurrency)} ${tx.sourceCurrency.toUpperCase()}` : null, tx.fee ? `Wise fee ${toDecimalString(tx.fee, tx.sourceCurrency ?? tx.currency)} ${(tx.sourceCurrency ?? tx.currency).toUpperCase()} borne by Bilit` : null].filter(Boolean).join(", ") } });
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
  const recordBill = (tx: Tx, kind: "BILL" | "EXPENSE") => setBill({ kind, prefill: { supplierName: tx.counterparty ?? "", invoiceDate: tx.occurredAt.slice(0, 10), currency: tx.currency, total: tx.amount, paymentReference: `Wise #${tx.refNumber}`, paidFrom: tx.kind === "CARD" ? "CARD" : "BANK",
    description: [tx.kind === "CARD" ? `Wise card payment${tx.description ? ` (${tx.description})` : ""}` : `Wise transfer to ${tx.counterparty ?? "recipient"}`, tx.reference ? `reference “${tx.reference}”` : null, tx.fee ? `Wise fee ${toDecimalString(tx.fee, tx.sourceCurrency ?? tx.currency)} ${(tx.sourceCurrency ?? tx.currency).toUpperCase()}` : null].filter(Boolean).join(", ") } });
  const eligible = (x: Tx) => x.direction === "OUT" && !x.organiserPaymentId && !x.billId && !x.partnerPaymentId && !x.ignored;
  const pageEligible = (list.data?.items ?? []).filter(eligible);
  const toggle = (id: string) => setSel((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOnPage = pageEligible.length > 0 && pageEligible.every((x) => sel.has(x.id));
  const selected = (list.data?.items ?? []).filter((x) => sel.has(x.id));
  const selTotals = [...selected.reduce((m, x) => m.set(x.currency, (m.get(x.currency) ?? 0) + x.amount), new Map<string, number>())];
  const runBulk = async () => {
    setBulkBusy(true); setBulkErr(null);
    try {
      const r = await api<{ done: number; failed: Array<{ id: string; error: string }>; total: number }>("/api/accounting/wise/bulk", { json: { ids: [...sel], action: bulk, reason: bulkV.reason || null, accountId: bulkV.accountId || null, organiserId: bulkV.organiserId || null, partnerId: bulkV.partnerId || null } });
      toast(r.failed.length ? "error" : "ok", t("bulkDone", { done: r.done, total: r.total }));
      if (r.failed.length) { setBulkErr(r.failed.map((f) => `${(list.data?.items ?? []).find((x) => x.id === f.id)?.counterparty ?? f.id}: ${f.error}`).join("\n")); setSel(new Set(r.failed.map((f) => f.id))); }
      else { setSel(new Set()); setBulk(null); }
      await reloadAll();
    } catch (e) { setBulkErr(errMsg(e)); } finally { setBulkBusy(false); }
  };

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
          action={admin ? <Link href="/accounting/settings#wise" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-muted hover:bg-surface-2 hover:text-fg"><Settings className="size-4" aria-hidden />{t("manage")}</Link> : null} />
          <div className="space-y-4 p-5">
            <WiseBalances balances={s.balances} />
            {s.status === "ERROR" && s.lastError && <Callout tone="warn" title={t("syncError")}>{s.lastError}</Callout>}
            {s.toRecord > 0 && <Callout tone="warn" title={t("toRecordTitle", { n: s.toRecord })}>{t("toRecordDesc")}</Callout>}
          </div>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div className="flex flex-wrap gap-1.5">{VIEWS.map((v) => <button key={v} type="button" onClick={() => { setView(v); setPage(1); setSel(new Set()); }} aria-pressed={view === v} className={`rounded-full border px-3 py-1 text-sm ${view === v ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg"}`}>{t(`view.${v}`)}{v === "torecord" && s.toRecord ? ` (${s.toRecord})` : ""}</button>)}</div>
            <Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-56" />
          </div>
          {manage && sel.size > 0 && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-5 py-2.5 text-sm">
            <span className="font-medium">{t("selected", { n: sel.size })}</span>
            <span className="text-muted">{selTotals.map(([c2, v2]) => <Money key={c2} v={v2} c={c2} className="me-2" />)}</span>
            <span className="ms-auto flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => { setBulkErr(null); setBulk("expense"); }}><Receipt className="size-3.5" aria-hidden />{t("expense")}</Button>
              <Button size="sm" onClick={() => { setBulkErr(null); setBulk("bill"); }}><FileText className="size-3.5" aria-hidden />{t("invoice")}</Button>
              <Button size="sm" onClick={() => { setBulkErr(null); setBulk("organiser"); }}><Banknote className="size-3.5" aria-hidden />{t("record")}</Button>
              <Button size="sm" onClick={() => { setBulkErr(null); setBulk("partner"); }}><HandCoins className="size-3.5" aria-hidden />{t("partnerPay")}</Button>
              <Button size="sm" onClick={() => { setBulkErr(null); setBulk("ignore"); }}><EyeOff className="size-3.5" aria-hidden />{t("ignore")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>{t("clearSel")}</Button>
            </span>
          </div>}
          {list.loading && !list.data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !list.data?.items.length ? <EmptyState title={t(view === "torecord" ? "emptyToRecord" : "empty")} description={t("emptyDesc")} /> : <>
            <TableWrap><Table><thead><tr>{manage && <Th className="w-8"><input type="checkbox" aria-label={t("selectAll")} disabled={!pageEligible.length} checked={allOnPage} onChange={() => setSel((o) => { const n = new Set(o); pageEligible.forEach((x) => (allOnPage ? n.delete(x.id) : n.add(x.id))); return n; })} /></Th>}<Th>{t("date")}</Th><Th>{t("counterparty")}</Th><Th>{t("reference")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("match")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
              <tbody>{list.data.items.map((x) => <Tr key={x.id} className={x.ignored ? "text-muted" : sel.has(x.id) ? "bg-accent-soft/50" : ""}>
                {manage && <Td>{eligible(x) && <input type="checkbox" aria-label={t("selectRow", { name: x.counterparty ?? x.wiseId })} checked={sel.has(x.id)} onChange={() => toggle(x.id)} />}</Td>}
                <Td className="whitespace-nowrap">{fmtDate(x.occurredAt, locale, { dateStyle: "medium" })}<span className="block text-xs text-muted">{x.kind.toLowerCase()}{x.status && x.status !== "completed" ? ` · ${x.status.replaceAll("_", " ")}` : ""}</span></Td>
                <Td className="min-w-44"><span className="inline-flex items-center gap-1.5 font-medium">{x.direction === "OUT" ? <ArrowUpRight className="size-4 shrink-0" aria-label={t("out")} /> : <ArrowDownLeft className="size-4 shrink-0" aria-label={t("in")} />}{x.counterparty ?? x.description ?? "—"}</span><code className="block text-xs text-muted">{x.wiseId.split(":")[0]}</code></Td>
                <Td className="max-w-56 truncate text-sm" title={x.reference ?? ""}>{x.reference ?? "—"}</Td>
                <Td className="text-end"><Money v={x.direction === "OUT" ? -x.amount : x.amount} c={x.currency} strong />
                  {x.sourceCurrency && x.sourceCurrency !== x.currency && x.sourceAmount != null && <span className="block text-xs text-muted"><Money v={x.sourceAmount} c={x.sourceCurrency} /></span>}
                  {x.fee ? <span className="block text-xs text-muted">{t("fee")} <Money v={x.fee} c={x.sourceCurrency ?? x.currency} /></span> : null}</Td>
                <Td className="min-w-44 text-sm">
                  {x.partnerPaymentId ? <span>{t("bookedPartner")} <Link href="/accounting/profit-share" className="font-medium underline-offset-4 hover:underline">{x.partnerName}</Link></span>
                    : x.billId ? <span>{t(x.billKind === "BILL" ? "bookedBill" : "bookedExpense")} <Link href="/accounting/books/invoices" className="font-medium underline-offset-4 hover:underline">{x.billSupplier}</Link></span>
                    : x.organiserPaymentId ? <span>{t("recordedFor")} <Link href={`/accounting/organisers/${x.paymentOrganiserId}?tab=payments`} className="font-medium underline-offset-4 hover:underline">{x.paymentOrganiserName}</Link></span>
                    : x.stripePayoutId ? <span>{t("stripePayout")} <code className="text-xs">{x.stripePayoutId}</code></span>
                    : x.ignored ? <span>{t("ignoredAs", { reason: x.ignoredReason ?? "" })}</span>
                    : x.direction === "OUT" && x.kind === "TRANSFER" ? <span className="text-muted">{x.suggestedName ? t("suggested", { name: x.suggestedName }) : t("notRecorded")}</span> : <span className="text-muted">—</span>}
                </Td>
                <Td className="text-end"><div className="flex justify-end gap-1">
                  {manage && !x.organiserPaymentId && !x.billId && !x.partnerPaymentId && !x.ignored && x.direction === "OUT" && x.kind === "TRANSFER" && <Button size="sm" variant="primary" onClick={() => record(x)}><Banknote className="size-3.5" aria-hidden />{t("record")}</Button>}
                  {manage && !x.organiserPaymentId && !x.billId && !x.partnerPaymentId && !x.ignored && x.direction === "OUT" && <>
                    <Button size="sm" onClick={() => recordBill(x, "EXPENSE")} title={t("expenseHint")}><Receipt className="size-3.5" aria-hidden />{t("expense")}</Button>
                    <Button size="sm" onClick={() => recordBill(x, "BILL")} title={t("invoiceHint")}><FileText className="size-3.5" aria-hidden />{t("invoice")}</Button></>}
                  {manage && !x.organiserPaymentId && !x.billId && !x.partnerPaymentId && !x.ignored && <Button size="sm" variant="ghost" onClick={() => { setReason(""); setIgn(x); }} aria-label={t("ignore")} title={t("ignore")}><EyeOff className="size-3.5" aria-hidden /></Button>}
                  {manage && x.ignored && <Button size="sm" variant="ghost" onClick={async () => { try { await api(`/api/accounting/wise/transactions/${x.id}/ignore`, { json: { ignored: false } }); await reloadAll(); } catch (e) { toast("error", errMsg(e)); } }} aria-label={t("unignore")} title={t("unignore")}><RotateCcw className="size-3.5" aria-hidden /></Button>}
                </div></Td></Tr>)}</tbody></Table></TableWrap>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} /></>}
        </Card>
        <p className="text-xs text-muted">{t("liveNote")}</p>
      </>}

      {agentText && <PaymentAgentDialog open onClose={() => setAgentText(null)} onSaved={() => void reloadAll()} initialText={agentText} autoRun forceMode="live" />}
      {bulk && <Modal open onClose={() => setBulk(null)} title={t(`bulk.${bulk}.title`, { n: sel.size })} description={t(`bulk.${bulk}.desc`)}
        footer={<><Button onClick={() => setBulk(null)}>{t("cancel")}</Button><Button variant="primary" loading={bulkBusy} disabled={(bulk === "expense" || bulk === "bill") ? !bulkV.accountId : bulk === "organiser" ? !bulkV.organiserId : bulk === "partner" ? !bulkV.partnerId : bulkV.reason.trim().length < 3} onClick={runBulk}>{t(`bulk.${bulk}.go`, { n: sel.size })}</Button></>}>
        <div className="space-y-4">
          {(bulk === "expense" || bulk === "bill") && <Field label={t("category")} required>{(p) => <Select {...p} value={bulkV.accountId} onChange={(e) => setBulkV({ ...bulkV, accountId: e.target.value })}><option value="">—</option>{accounts.map((a2) => <option key={a2.id} value={a2.id}>{a2.code} · {a2.name}</option>)}</Select>}</Field>}
          {bulk === "organiser" && <Field label={t("organiser")} required>{(p) => <Select {...p} value={bulkV.organiserId} onChange={(e) => setBulkV({ ...bulkV, organiserId: e.target.value })}><option value="">—</option>{orgs.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>}
          {bulk === "partner" && <Field label={t("partnerLabel")} required>{(p) => <Select {...p} value={bulkV.partnerId} onChange={(e) => setBulkV({ ...bulkV, partnerId: e.target.value })}><option value="">—</option>{partnersL.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.sharePercent}%</option>)}</Select>}</Field>}
          {bulk === "ignore" && <Field label={t("ignoreReason")} required>{(p) => <Textarea {...p} value={bulkV.reason} onChange={(e) => setBulkV({ ...bulkV, reason: e.target.value })} placeholder={t("ignorePlaceholder")} />}</Field>}
          <ul className="scroll-thin max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm">{selected.map((x) => <li key={x.id} className="flex justify-between gap-3 px-3 py-1.5"><span className="truncate">{x.occurredAt.slice(0, 10)} · {x.counterparty ?? x.wiseId}</span><Money v={x.amount} c={x.currency} /></li>)}</ul>
          <p className="text-xs text-muted">{t("bulkNote")}</p>
          {bulkErr && <Callout tone="warn"><span className="whitespace-pre-line">{bulkErr}</span></Callout>}
        </div>
      </Modal>}
      {bill && <BillDialog kind={bill.kind} mode="live" prefill={bill.prefill} onClose={() => setBill(null)} onSaved={() => void reloadAll()} />}
      {rec && <PaymentDialog open onClose={() => setRec(null)} onSaved={() => void reloadAll()} mode="live" organiserId={rec.tx.suggestedOrganiserId ?? undefined} prefill={rec.prefill} />}
      <ConfirmDialog open={!!ign} onClose={() => setIgn(null)} title={t("ignoreTitle")} description={t("ignoreDesc")} confirmLabel={t("ignore")}
        onConfirm={async () => { try { await api(`/api/accounting/wise/transactions/${ign!.id}/ignore`, { json: { ignored: true, reason } }); await reloadAll(); } catch (e) { toast("error", errMsg(e)); throw e; } }}>
        <Field label={t("ignoreReason")} required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ignorePlaceholder")} />}</Field>
      </ConfirmDialog>
    </div>
  );
}
