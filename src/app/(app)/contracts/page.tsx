"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Archive, BellRing, Download, FilePlus2, Search, XCircle } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button, LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { PageHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";

type Row = { id: string; reference: string; name: string; status: string; contractType: string; updatedAt: string; expiresAt: string | null; senderName: string; recipientsTotal: number; recipientsSigned: number; nextSigner: string | null };
type Page = { items: Row[]; page: number; pageSize: number; total: number };
const STATUSES = ["DRAFT", "READY_TO_SEND", "SENT", "DELIVERED", "VIEWED", "PARTIALLY_SIGNED", "AWAITING_SIGNATURE", "COMPLETED", "DECLINED", "CANCELLED", "EXPIRED", "VOIDED"];
const SORTS = ["created", "updated", "expires", "name", "reference", "status"];

export default function Contracts() { return <Suspense><ContractsInner /></Suspense>; }

function ContractsInner() {
  const t = useTranslations("contracts.list");
  const c = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const { can } = useMe();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const dq = useDebounced(q);
  const status = sp.get("status") ?? "";
  const sort = sp.get("sort") ?? "created";
  const archived = sp.get("archived") === "include";
  const page = Number(sp.get("page") ?? 1) || 1;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmCancel, setConfirmCancel] = useState(false);

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
    if (!("page" in patch)) n.delete("page");
    router.replace(`/contracts?${n.toString()}`);
  };
  useEffect(() => {
    if ((sp.get("q") ?? "") !== dq) set({ q: dq || null });
    // Only the debounced value should trigger a URL update; sp/set change on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: "25", sort, dir: sort === "name" || sort === "reference" || sort === "expires" ? "asc" : "desc" });
    if (dq) p.set("q", dq); if (status) p.set("status", status); if (archived) p.set("archived", "include");
    return p.toString();
  }, [page, sort, dq, status, archived]);
  const { data, loading, reload } = useApi<Page>(`/api/contracts?${qs}`);
  useEffect(() => setSel(new Set()), [qs]);

  const bulk = async (action: "archive" | "cancel" | "remind") => {
    try {
      const r = await api<{ results: Array<{ ok: boolean }>; succeeded: number }>("/api/contracts/bulk", { json: { action, ids: [...sel] } });
      const failed = r.results.length - r.succeeded;
      toast(failed ? "info" : "ok", failed ? t("bulkPartial", { ok: r.succeeded, failed }) : t("bulkDone", { count: r.succeeded }));
      setSel(new Set()); void reload();
    } catch (e) { toast("error", errMsg(e)); }
  };
  const exportHref = `/api/contracts/export?${new URLSearchParams([...(dq ? [["q", dq]] : []), ...(status ? [["status", status]] : [])]).toString()}`;
  const filtered = !!(dq || status || archived);
  const items = data?.items ?? [];
  const allSel = items.length > 0 && items.every((i) => sel.has(i.id));

  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        <a href={exportHref} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2"><Download className="size-4" aria-hidden />{t("export")}</a>
        {can("contracts.create") && <LinkButton href="/contracts/new" variant="primary"><FilePlus2 className="size-4" aria-hidden />{t("new")}</LinkButton>}
      </>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchPh")} aria-label={t("searchPh")} className="ps-10" /></div>
          <Select value={status} onChange={(e) => set({ status: e.target.value || null })} aria-label={t("status")} className="w-auto min-w-44"><option value="">{t("allStatuses")}</option>{STATUSES.map((s) => <option key={s} value={s}>{c(`status.contract.${s}`)}</option>)}</Select>
          <Select value={sort} onChange={(e) => set({ sort: e.target.value })} aria-label={t("sort")} className="w-auto min-w-40">{SORTS.map((s) => <option key={s} value={s}>{t(`sorts.${s}`)}</option>)}</Select>
          <Checkbox label={t("showArchived")} checked={archived} onChange={(e) => set({ archived: e.target.checked ? "include" : null })} />
        </div>
        {sel.size > 0 && (
          <div role="region" aria-live="polite" className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-2.5 text-sm">
            <span className="font-medium">{t("selected", { count: sel.size })}</span>
            <div className="ms-auto flex gap-2">
              {can("contracts.remind") && <Button size="sm" onClick={() => bulk("remind")}><BellRing className="size-4" aria-hidden />{t("bulk.remind")}</Button>}
              {can("contracts.edit") && <Button size="sm" onClick={() => bulk("archive")}><Archive className="size-4" aria-hidden />{t("bulk.archive")}</Button>}
              {can("contracts.cancel") && <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)}><XCircle className="size-4" aria-hidden />{t("bulk.cancel")}</Button>}
            </div>
          </div>
        )}
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          : items.length === 0 ? (filtered
            ? <EmptyState title={t("noMatch")} action={<Button onClick={() => { setQ(""); router.replace("/contracts"); }}>{t("clear")}</Button>} />
            : <EmptyState icon={<FilePlus2 className="size-6" />} title={t("empty")} description={t("emptyDesc")} action={can("contracts.create") ? <LinkButton href="/contracts/new" variant="primary">{t("new")}</LinkButton> : undefined} />)
          : (
            <TableWrap>
              <Table>
                <thead><tr>
                  <Th className="w-10"><input type="checkbox" aria-label={t("selectAll")} checked={allSel} onChange={(e) => setSel(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} className="size-4 accent-[var(--color-5)]" /></Th>
                  <Th>{t("cols.contract")}</Th><Th>{c("statusLabel")}</Th><Th>{t("cols.signers")}</Th><Th>{t("cols.sender")}</Th><Th>{t("cols.expires")}</Th><Th>{t("cols.updated")}</Th>
                </tr></thead>
                <tbody>{items.map((r) => (
                  <Tr key={r.id}>
                    <Td><input type="checkbox" aria-label={t("selectRow", { name: r.name })} checked={sel.has(r.id)} onChange={(e) => setSel((s) => { const n = new Set(s); e.target.checked ? n.add(r.id) : n.delete(r.id); return n; })} className="size-4 accent-[var(--color-5)]" /></Td>
                    <Td className="max-w-xs"><Link href={`/contracts/${r.id}`} className="block truncate font-medium hover:underline">{r.name}</Link><span className="num text-xs text-muted">{r.reference}</span></Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td className="whitespace-nowrap"><span className="num">{t("progress", { signed: r.recipientsSigned, total: r.recipientsTotal })}</span>{r.nextSigner && r.status !== "COMPLETED" && <span className="block text-xs text-muted">{t("next", { name: r.nextSigner })}</span>}</Td>
                    <Td className="whitespace-nowrap text-muted">{r.senderName}</Td>
                    <Td className="whitespace-nowrap text-muted">{fmtDate(r.expiresAt, locale, { dateStyle: "medium" })}</Td>
                    <Td className="whitespace-nowrap text-muted">{fmtDate(r.updatedAt, locale)}</Td>
                  </Tr>
                ))}</tbody>
              </Table>
            </TableWrap>
          )}
        {data && data.total > 0 && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
      <ConfirmDialog open={confirmCancel} onClose={() => setConfirmCancel(false)} title={t("bulkCancelTitle", { count: sel.size })} description={t("bulkCancelDesc")} confirmLabel={t("bulk.cancel")} onConfirm={() => bulk("cancel")} />
    </div>
  );
}
