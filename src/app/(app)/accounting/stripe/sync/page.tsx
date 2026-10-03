"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarRange, History, RefreshCw, RotateCcw, Scale } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { StripeNav } from "../nav";

type Run = { id: string; kind: string; status: string; rangeFrom: string | null; rangeTo: string | null; discovered: number; imported: number; existing: number; newlyMatched: number; unmatched: number; errors: number; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null };
type Err = { id: string; objectId: string | null; stage: string; message: string; createdAt: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function SyncPage() {
  const t = useTranslations("accounting.stripe.sync");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const { mode, q } = useMode();
  const { data, reload } = useApi<{ runs: Run[]; errors: Err[] }>(q("/api/accounting/stripe/sync"));
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const active = data?.runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  useEffect(() => { if (!active) return; const i = setInterval(() => void reload(), 3000); return () => clearInterval(i); }, [active, reload]);
  const start = async (kind: string, f?: string, tt?: string) => {
    setBusy(kind + (f ?? ""));
    try { await api("/api/accounting/stripe/sync", { json: { mode, kind, from: f, to: tt } }); toast("ok", t("queued")); await reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(null); }
  };
  const now = new Date();
  const presets: Array<[string, string, string]> = [["today", iso(now), iso(now)], ["week", iso(new Date(now.getTime() - 6 * 86400_000)), iso(now)], ["month", iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)]];
  const manage = can("accounting.manage");
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <StripeNav />
      {manage && <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title={<span className="flex items-center gap-2"><RefreshCw className="size-4" aria-hidden />{t("quick")}</span>} description={t("quickDesc")} />
          <div className="flex flex-wrap gap-2 p-5">{presets.map(([k, f, tt]) => <Button key={k} loading={busy === `RANGE${f}`} disabled={!!active} onClick={() => start("RANGE", f, tt)}>{t(`p.${k}`)}</Button>)}
            <Button loading={busy === "RECENT"} disabled={!!active} onClick={() => start("RECENT")}>{t("p.recent")}</Button></div></Card>
        <Card><CardHeader title={<span className="flex items-center gap-2"><CalendarRange className="size-4" aria-hidden />{t("custom")}</span>} />
          <div className="flex flex-wrap items-end gap-3 p-5"><Field label={t("from")}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field><Field label={t("to")}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            <Button variant="primary" disabled={!from || !to || !!active} loading={busy === `RANGE${from}`} onClick={() => start("RANGE", from, to)}>{t("run")}</Button></div></Card>
        <Card className="lg:col-span-2"><div className="flex flex-wrap gap-2 p-5">
          <Button loading={busy === "FULL"} disabled={!!active} onClick={() => start("FULL")}><History className="size-4" aria-hidden />{t("full")}</Button>
          <Button loading={busy === "RETRY"} disabled={!!active || !data?.errors.length} onClick={() => start("RETRY")}><RotateCcw className="size-4" aria-hidden />{t("retry", { n: data?.errors.length ?? 0 })}</Button>
          <Button loading={busy === "RECONCILE"} onClick={() => start("RECONCILE")}><Scale className="size-4" aria-hidden />{t("reconcile")}</Button>
          <p className="basis-full text-xs text-muted">{t("idempotent")}</p></div></Card>
      </div>}
      <Card><CardHeader title={t("runs")} description={active ? t("running") : undefined} />
        {!data?.runs.length ? <EmptyState title={t("noRuns")} /> : <TableWrap><Table><thead><tr><Th>{t("started")}</Th><Th>{t("kind")}</Th><Th>{t("range")}</Th><Th>{t("status")}</Th><Th className="text-end">{t("c.discovered")}</Th><Th className="text-end">{t("c.imported")}</Th><Th className="text-end">{t("c.existing")}</Th><Th className="text-end">{t("c.newlyMatched")}</Th><Th className="text-end">{t("c.unmatched")}</Th><Th className="text-end">{t("c.errors")}</Th></tr></thead>
          <tbody>{data.runs.map((r) => <Tr key={r.id}><Td className="whitespace-nowrap text-muted">{fmtDate(r.startedAt ?? r.createdAt, locale)}</Td><Td>{t(`k.${r.kind}`)}</Td><Td className="whitespace-nowrap text-xs">{r.rangeFrom ? r.rangeFrom.slice(0, 10) : "…"} → {r.rangeTo ? r.rangeTo.slice(0, 10) : t("now")}</Td>
            <Td><Badge s={r.status} />{r.error && <span className="block max-w-64 truncate text-xs text-muted" title={r.error}>{r.error}</span>}</Td>
            {[r.discovered, r.imported, r.existing, r.newlyMatched, r.unmatched, r.errors].map((n, i) => <Td key={i} className="num text-end">{n}</Td>)}</Tr>)}</tbody></Table></TableWrap>}
      </Card>
      {!!data?.errors.length && <div className="mt-6"><Card><CardHeader title={t("errors")} description={t("errorsDesc")} />
        <ul className="divide-y divide-line">{data.errors.map((e) => <li key={e.id} className="px-5 py-3 text-sm"><code className="text-xs">{e.objectId ?? "—"}</code> · {e.stage} · <span className="text-muted">{fmtDate(e.createdAt, locale)}</span><p className="mt-1 text-muted">{e.message}</p></li>)}</ul></Card></div>}
      <div className="mt-6"><Callout title={t("howTitle")}>{t("how")}</Callout></div>
    </div>
  );
}
