"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Search, UserPlus } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge, Money, useMode } from "@/components/accounting/kit";
import { OrganiserDialog } from "@/components/accounting/forms";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { useApi } from "@/lib/api";

type O = { id: string; name: string; email: string | null; companyName: string | null; internalRef: string | null; active: boolean; eventCount: number; hasBankDetails: boolean; bankHint: string | null; money: Array<{ currency: string; profit: number; remaining: number; gross: number }> };

export default function OrganisersPage() {
  const t = useTranslations("accounting.organisers");
  const router = useRouter();
  const { can } = useMe();
  const { q: withMode } = useMode();
  const [q, setQ] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 300);
  const { data, loading } = useApi<{ items: O[]; total: number; page: number; pageSize: number }>(withMode(`/api/accounting/organisers?page=${page}&pageSize=50${dq ? `&q=${encodeURIComponent(dq)}` : ""}`));
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={can("accounting.manage") && <Button variant="primary" onClick={() => setOpen(true)}><UserPlus className="size-4" aria-hidden />{t("create")}</Button>} />
      <div className="relative mb-4 max-w-md"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("name")}</Th><Th>{t("internalRef")}</Th><Th>{t("email")}</Th><Th className="text-end">{t("events")}</Th><Th className="text-end">{t("profit")}</Th><Th className="text-end">{t("remaining")}</Th><Th>{t("bank")}</Th><Th>{t("status")}</Th></tr></thead>
            <tbody>{data.items.map((o) => <Tr key={o.id}>
              <Td><Link href={`/accounting/organisers/${o.id}`} className="font-medium underline-offset-4 hover:underline">{o.name}</Link>{o.companyName && o.companyName !== o.name && <span className="block text-xs text-muted">{o.companyName}</span>}</Td>
              <Td><code className="text-xs">{o.internalRef ?? "—"}</code></Td><Td>{o.email ?? "—"}</Td><Td className="num text-end">{o.eventCount}</Td>
              <Td className="text-end">{o.money.length ? o.money.map((m) => <span key={m.currency} className="block"><Money v={m.profit} c={m.currency} strong className={m.profit < 0 ? "text-fin-neg" : "text-fin-pos"} /></span>) : <span className="text-muted">—</span>}</Td>
              <Td className="text-end">{o.money.length ? o.money.map((m) => <span key={m.currency} className="block"><Money v={m.remaining} c={m.currency} className={m.remaining > 0 ? "text-fin-warn" : ""} /></span>) : <span className="text-muted">—</span>}</Td><Td className="text-xs">{o.hasBankDetails ? o.bankHint ?? "✓" : "—"}</Td><Td><Badge s={o.active ? "ACTIVE" : "INACTIVE"} /></Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {open && <OrganiserDialog open={open} onClose={() => setOpen(false)} onSaved={(id) => router.push(`/accounting/organisers/${id}`)} />}
    </div>
  );
}
