"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarPlus, Link2, Scale } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge, Money, Reason, useMode } from "@/components/accounting/kit";
import { MatchDialog } from "@/components/accounting/match";
import { EventDialog } from "@/components/accounting/forms";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import type { TxRow } from "../transactions/page";

type Recon = { at: string; ledgerErrors: number; chargesWithoutBalanceTransaction: number; byStatus: Record<string, number>; currencies: Array<{ currency: string; ledgerStripeBalance: number; importedNet: number; ledgerDifference: number; stripeReportedBalance: number | null; stripeDifference: number | null }>; balanceError: string | null };
/** "Order (x) for event: Blood In Blood Out Berlin (B41-0091), by …" → "Blood In Blood Out Berlin". */
const eventNameFrom = (d: string | null, code: string) => {
  const i = d ? d.toUpperCase().lastIndexOf(`(${code.toUpperCase()})`) : -1;
  const m = i > 0 ? /for event:\s*(.*)$/.exec(d!.slice(0, i)) : null;
  return m?.[1]?.trim().replace(/\s+/g, " ") ?? "";
};
const STATUSES = ["UNMATCHED", "PARTIAL", "DUPLICATE", "MANUAL_REVIEW", "ERROR", "MATCHED", "REFUND", "DISPUTE"];

export default function ReconciliationPage() {
  const t = useTranslations("accounting.recon");
  const ts = useTranslations("accounting.status");
  const tk = useTranslations("accounting.kind");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const { mode, q } = useMode();
  const [status, setStatus] = useState(""); const [page, setPage] = useState(1); const [sel, setSel] = useState<TxRow | null>(null); const [busy, setBusy] = useState(false);
  const [newEv, setNewEv] = useState<{ code: string; name: string; currency: string } | null>(null);
  const { data, loading, reload } = useApi<{ items: TxRow[]; total: number; page: number; pageSize: number; lastReconciliation: Recon | null; lastRunAt: string | null }>(q(`/api/accounting/reconciliation?page=${page}&pageSize=50${status ? `&status=${status}` : ""}`));
  const run = async () => { setBusy(true); try { await api("/api/accounting/stripe/sync", { json: { mode, kind: "RECONCILE" } }); toast("ok", t("queued")); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  const r = data?.lastReconciliation;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={can("accounting.manage") && <Button loading={busy} onClick={run}><Scale className="size-4" aria-hidden />{t("run")}</Button>} />
      <Card><CardHeader title={t("summary")} description={r ? t("lastRun", { at: fmtDate(r.at, locale) }) : t("neverRun")} />
        {r && <div className="space-y-4 p-5">
          <div className="flex flex-wrap gap-2">{Object.entries(r.byStatus).map(([s, n]) => <span key={s} className="inline-flex items-center gap-2"><Badge s={s} /><span className="num text-sm">{n}</span></span>)}</div>
          {(r.ledgerErrors > 0 || r.chargesWithoutBalanceTransaction > 0) && <Callout tone="warn" title={t("problems")}>{t("problemsDesc", { ledger: r.ledgerErrors, charges: r.chargesWithoutBalanceTransaction })}</Callout>}
          <TableWrap><Table><thead><tr><Th>{t("currency")}</Th><Th className="text-end">{t("importedNet")}</Th><Th className="text-end">{t("ledgerBalance")}</Th><Th className="text-end">{t("ledgerDiff")}</Th><Th className="text-end">{t("stripeBalance")}</Th><Th className="text-end">{t("stripeDiff")}</Th></tr></thead>
            <tbody>{r.currencies.map((c) => <Tr key={c.currency}><Td className="uppercase">{c.currency}</Td><Td className="text-end"><Money v={c.importedNet} c={c.currency} /></Td><Td className="text-end"><Money v={c.ledgerStripeBalance} c={c.currency} /></Td>
              <Td className="text-end">{c.ledgerDifference === 0 ? <Badge s="MATCHED" /> : <Money v={c.ledgerDifference} c={c.currency} strong />}</Td><Td className="text-end"><Money v={c.stripeReportedBalance} c={c.currency} /></Td>
              <Td className="text-end">{c.stripeDifference === null ? "—" : c.stripeDifference === 0 ? <Badge s="MATCHED" /> : <Money v={c.stripeDifference} c={c.currency} strong />}</Td></Tr>)}</tbody></Table></TableWrap>
          <p className="text-xs text-muted">{t("stripeDiffNote")}</p>
          {r.balanceError && <p className="text-xs text-muted">{r.balanceError}</p>}
        </div>}
      </Card>
      <Card><CardHeader title={t("queue")} description={t("queueDesc")} action={<Select aria-label={t("status")} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto"><option value="">{t("unreconciled")}</option>{STATUSES.map((s) => <option key={s} value={s}>{ts(s)}</option>)}</Select>} />
        {loading && !data ? <Skeleton className="m-4 h-24" /> : !data?.items.length ? <EmptyState title={t("clear")} description={t("clearDesc")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("date")}</Th><Th>{t("kind")}</Th><Th>{t("description")}</Th><Th>{t("code")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((x) => <Tr key={x.id}><Td className="whitespace-nowrap text-muted">{fmtDate(x.stripeCreatedAt, locale)}</Td><Td>{tk(x.kind)}</Td>
              <Td className="max-w-72"><Link href={`/accounting/transactions/${x.id}`} className="block truncate underline-offset-4 hover:underline">{x.description || x.balanceTransactionId}</Link>{x.customerName && <span className="block truncate text-xs text-muted">{x.customerName}</span>}</Td>
              <Td>{x.eventCode ? <code className="text-xs">{x.eventCode}</code> : "—"}</Td><Td className="text-end"><Money v={x.amount} c={x.currency} /></Td><Td><Badge s={x.reconciliationStatus} /><div><Reason r={x.matchReason} /></div></Td>
              <Td className="whitespace-nowrap text-end">{can("accounting.manage") && x.matchReason === "CODE_NOT_FOUND" && x.eventCode && <Button size="sm" className="me-1" onClick={() => setNewEv({ code: x.eventCode!, name: eventNameFrom(x.description, x.eventCode!), currency: x.currency })}><CalendarPlus className="size-3.5" aria-hidden />{t("createEvent")}</Button>}
                {can("accounting.manage") && ["SALE", "REFUND", "DISPUTE", "DISPUTE_REVERSAL", "OTHER"].includes(x.kind) && <Button size="sm" onClick={() => setSel(x)}><Link2 className="size-3.5" aria-hidden />{x.kind === "OTHER" ? t("classify") : t("match")}</Button>}</Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      <MatchDialog tx={sel} open={!!sel} onClose={() => setSel(null)} onDone={reload} />
      {newEv && <EventDialog open onClose={() => setNewEv(null)} onSaved={() => { setNewEv(null); void reload(); }} initial={{ name: newEv.name, code: newEv.code, currency: newEv.currency, organiserId: "", startsOn: "", status: "ACTIVE", notes: "" }} />}
    </div>
  );
}
