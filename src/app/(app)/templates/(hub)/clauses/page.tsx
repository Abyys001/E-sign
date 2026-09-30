"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpen, Search } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

export type ClauseRow = { id: string; clauseKey: string; category: string; module: string; title: string; version: number; language: string; jurisdiction: string; body: string; reviewStatus: string; status: string };

export default function ClausesPage() {
  const t = useTranslations("intake.clauses");
  const c = useTranslations("common");
  const toast = useToast();
  const { can } = useMe();
  const { data, loading, reload } = useApi<{ categories: string[]; items: ClauseRow[] }>("/api/clauses?status=PUBLISHED");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [jur, setJur] = useState("");
  const [view, setView] = useState<ClauseRow | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => (data?.items ?? []).filter((r) => (!cat || r.category === cat) && (!jur || r.jurisdiction === jur) && (!q || `${r.title} ${r.clauseKey} ${r.body}`.toLowerCase().includes(q.toLowerCase()))), [data, q, cat, jur]);
  const jurs = useMemo(() => [...new Set((data?.items ?? []).map((r) => r.jurisdiction))].sort(), [data]);
  const seed = async () => { setBusy(true); try { await api("/api/clauses/seed", { method: "POST" }); await reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  const review = async (r: ClauseRow, reviewStatus: string) => { try { await api(`/api/clauses/versions/${r.id}/review`, { json: { reviewStatus } }); toast("ok", t("reviewSaved")); setView(null); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={can("templates.edit") && <Button loading={busy} onClick={seed}>{t("seed")}</Button>} />
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_180px_180px]">
        <div className="relative"><Search className="pointer-events-none absolute start-3 top-3 size-4 text-muted" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("cols.category")}><option value="">{t("allCategories")}</option>{data?.categories.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
        <Select value={jur} onChange={(e) => setJur(e.target.value)} aria-label={t("cols.jurisdiction")}><option value="">{t("allJurisdictions")}</option>{jurs.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
      </div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !rows.length ? <EmptyState icon={<BookOpen className="size-6" />} title={t("empty")} description={t("emptyDesc")} /> : (
          <TableWrap><Table><thead><tr><Th>{t("cols.clause")}</Th><Th>{t("cols.category")}</Th><Th>{t("cols.jurisdiction")}</Th><Th>{t("cols.version")}</Th><Th>{t("cols.review")}</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <Tr key={r.id}><Td><button type="button" className="text-start font-medium hover:underline" onClick={() => setView(r)}>{r.title}</button><span className="block text-xs text-muted">{r.clauseKey}</span></Td>
                <Td className="text-muted">{r.category}</Td><Td>{r.jurisdiction}</Td><Td className="num text-muted">v{r.version}</Td><Td>{t(`review.${r.reviewStatus}` as never)}</Td></Tr>))}</tbody></Table></TableWrap>)}
      </Card>
      <Modal open={!!view} onClose={() => setView(null)} size="lg" title={view?.title ?? ""} description={view ? `${view.clauseKey} · v${view.version} · ${view.jurisdiction}` : undefined}
        footer={view && can("settings.manage") ? <>{(["unreviewed", "in_review", "approved"] as const).filter((s) => s !== view.reviewStatus).map((s) => <Button key={s} onClick={() => review(view, s)}>{t(`markAs.${s}` as never)}</Button>)}<Button onClick={() => setView(null)}>{c("close")}</Button></> : <Button onClick={() => setView(null)}>{c("close")}</Button>}>
        {view && <><p className="whitespace-pre-wrap text-sm leading-relaxed">{view.body}</p><p className="mt-4 text-xs text-muted">{t("reviewNote")}</p></>}
      </Modal>
    </div>
  );
}
