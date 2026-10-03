"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Money, useMode } from "@/components/accounting/kit";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { fmtDate, useApi } from "@/lib/api";
import { StripeNav } from "../nav";

type D = { id: string; disputeId: string; chargeId: string | null; amount: number; currency: string; reason: string | null; status: string; accountingStatus: string; stripeCreatedAt: string; closedAt: string | null; eventName: string | null; eventCode: string | null; organiserName: string | null };

export default function DisputesPage() {
  const t = useTranslations("accounting.stripe.disputes");
  const locale = useLocale();
  const { q } = useMode();
  const [page, setPage] = useState(1);
  const { data, loading } = useApi<{ items: D[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/stripe/disputes?page=${page}&pageSize=50`));
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <StripeNav />
      <Card>
        {loading && !data ? <Skeleton className="m-4 h-24" /> : !data?.items.length ? <EmptyState title={t("empty")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("id")}</Th><Th>{t("created")}</Th><Th>{t("charge")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("reason")}</Th><Th>{t("status")}</Th><Th>{t("event")}</Th><Th>{t("organiser")}</Th><Th>{t("accounting")}</Th><Th>{t("closed")}</Th></tr></thead>
            <tbody>{data.items.map((d) => <Tr key={d.id}><Td><code className="text-xs">{d.disputeId}</code></Td><Td className="whitespace-nowrap text-muted">{fmtDate(d.stripeCreatedAt, locale, { dateStyle: "medium" })}</Td><Td><code className="text-xs">{d.chargeId}</code></Td>
              <Td className="text-end"><Money v={d.amount} c={d.currency} strong /></Td><Td>{d.reason}</Td><Td><code className="text-xs">{d.status}</code></Td><Td>{d.eventName ? <>{d.eventName} <code className="text-xs text-muted">{d.eventCode}</code></> : "—"}</Td><Td>{d.organiserName ?? "—"}</Td><Td><Badge s={d.accountingStatus} /></Td><Td>{d.closedAt ? fmtDate(d.closedAt, locale, { dateStyle: "medium" }) : "—"}</Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
    </div>
  );
}
