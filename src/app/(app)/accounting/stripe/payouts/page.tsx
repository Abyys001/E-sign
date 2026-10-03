"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Badge, Money, useExport, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { fmtDate, useApi } from "@/lib/api";
import { StripeNav } from "../nav";

type P = { id: string; payoutId: string; amount: number; currency: string; status: string; automatic: boolean; arrivalDate: string | null; stripeCreatedAt: string; stripeAccountId: string | null; includedCount: number | null; includedNet: number | null; reconciliationStatus: string; failureMessage: string | null };

export default function PayoutsPage() {
  const t = useTranslations("accounting.stripe.payouts");
  const locale = useLocale();
  const { q } = useMode();
  const ensure = useElevation();
  const exp = useExport();
  const [page, setPage] = useState(1);
  const { data, loading } = useApi<{ items: P[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/stripe/payouts?page=${page}&pageSize=50`));
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<Button onClick={() => exp(ensure, q("/api/accounting/stripe/payouts?x=1"))}><Download className="size-4" aria-hidden />{t("export")}</Button>} />
      <StripeNav />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("id")}</Th><Th>{t("date")}</Th><Th>{t("arrival")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th>{t("account")}</Th><Th>{t("included")}</Th><Th>{t("recon")}</Th></tr></thead>
            <tbody>{data.items.map((p) => <Tr key={p.id}>
              <Td><Link href={`/accounting/transactions?payoutId=${p.payoutId}`} className="underline-offset-4 hover:underline"><code className="text-xs">{p.payoutId}</code></Link>{!p.automatic && <span className="block text-xs text-muted">{t("manual")}</span>}</Td>
              <Td className="whitespace-nowrap text-muted">{fmtDate(p.stripeCreatedAt, locale, { dateStyle: "medium" })}</Td><Td className="whitespace-nowrap">{p.arrivalDate ? fmtDate(p.arrivalDate, locale, { dateStyle: "medium" }) : "—"}</Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><Badge s={p.status} />{p.failureMessage && <span className="block text-xs text-muted">{p.failureMessage}</span>}</Td>
              <Td><code className="text-xs">{p.stripeAccountId ?? "—"}</code></Td><Td>{p.includedCount ?? "—"}{p.includedNet != null && <span className="block text-xs text-muted"><Money v={p.includedNet} c={p.currency} /></span>}</Td><Td><Badge s={p.reconciliationStatus} /></Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
    </div>
  );
}
