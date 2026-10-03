"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarPlus, Import, Search } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge } from "@/components/accounting/kit";
import { EventDialog, ImportEventsDialog } from "@/components/accounting/forms";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useDebounced } from "@/lib/hooks";
import { useApi } from "@/lib/api";
import { bpsToPercent, formatMoney } from "@/lib/money";

type Ev = { id: string; name: string; code: string; currency: string; status: string; startsOn: string | null; organiserName: string | null; agreement: { version: number; percentBps: number; percentBasis: string; fixedPerTicket: number; fixedEventFee: number } | null };

export default function EventsPage() {
  const t = useTranslations("accounting.events");
  const router = useRouter();
  const { can } = useMe();
  const [q, setQ] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false); const [imp, setImp] = useState(false);
  const dq = useDebounced(q, 300);
  const { data, loading, reload } = useApi<{ items: Ev[]; total: number; page: number; pageSize: number }>(`/api/accounting/events?page=${page}&pageSize=50${dq ? `&q=${encodeURIComponent(dq)}` : ""}`);
  const model = (a: Ev["agreement"], c: string) => !a ? "—" : [a.percentBps ? `${bpsToPercent(a.percentBps)} % ${a.percentBasis === "NET" ? t("ofNet") : t("ofGross")}` : null, a.fixedPerTicket ? `${formatMoney(a.fixedPerTicket, c)} ${t("perTicket")}` : null, a.fixedEventFee ? `${formatMoney(a.fixedEventFee, c)} ${t("eventFee")}` : null].filter(Boolean).join(" + ") || t("noCommission");
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={can("accounting.manage") && <><Button onClick={() => setImp(true)}><Import className="size-4" aria-hidden />{t("importTx")}</Button><Button variant="primary" onClick={() => setOpen(true)}><CalendarPlus className="size-4" aria-hidden />{t("create")}</Button></>} />
      <div className="relative mb-4 max-w-md"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} action={can("accounting.manage") && <Button variant="primary" onClick={() => setImp(true)}><Import className="size-4" aria-hidden />{t("importTx")}</Button>} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("name")}</Th><Th>{t("code")}</Th><Th>{t("organiser")}</Th><Th>{t("currency")}</Th><Th>{t("agreement")}</Th><Th>{t("status")}</Th></tr></thead>
            <tbody>{data.items.map((e) => <Tr key={e.id}>
              <Td><Link href={`/accounting/events/${e.id}`} className="font-medium underline-offset-4 hover:underline">{e.name}</Link>{e.startsOn && <span className="block text-xs text-muted">{e.startsOn}</span>}</Td>
              <Td><code className="text-xs">{e.code}</code></Td><Td>{e.organiserName ?? <span className="text-muted">{t("noOrganiser")}</span>}</Td><Td className="uppercase">{e.currency}</Td>
              <Td className="text-sm">{model(e.agreement, e.currency)}{e.agreement && <span className="ms-1 text-xs text-muted">v{e.agreement.version}</span>}</Td><Td><Badge s={e.status} /></Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      {imp && <ImportEventsDialog onClose={() => setImp(false)} onSaved={() => void reload()} />}
      {open && <EventDialog open={open} onClose={() => setOpen(false)} onSaved={(id) => router.push(`/accounting/events/${id}`)} />}
    </div>
  );
}
