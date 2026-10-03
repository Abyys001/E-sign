"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, Link2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { PaymentDialog } from "@/components/accounting/forms";
import { Badge, Money, useExport, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { fmtDate, useApi } from "@/lib/api";
import { StripeNav } from "../nav";

type P = { id: string; payoutId: string; amount: number; currency: string; status: string; automatic: boolean; arrivalDate: string | null; stripeCreatedAt: string; stripeAccountId: string | null; includedCount: number | null; includedNet: number | null; reconciliationStatus: string; linkedPayments: Array<{ id: string; organiser: string; eventCode: string | null; amount: number; currency: string }>; failureMessage: string | null };

export default function PayoutsPage() {
  const t = useTranslations("accounting.stripe.payouts");
  const locale = useLocale();
  const ensure = useElevation();
  const exp = useExport();
  const { can } = useMe();
  const { mode, q } = useMode();
  const [page, setPage] = useState(1);
  const [link, setLink] = useState<P | null>(null);
  const { data, loading, reload } = useApi<{ items: P[]; total: number; page: number; pageSize: number }>(q(`/api/accounting/stripe/payouts?page=${page}&pageSize=50`));
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<Button onClick={() => exp(ensure, q("/api/accounting/stripe/payouts?x=1"))}><Download className="size-4" aria-hidden />{t("export")}</Button>} />
      <StripeNav />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.items.length ? <EmptyState title={t("empty")} description={t("emptyDesc")} /> : <>
          <TableWrap><Table><thead><tr><Th>{t("id")}</Th><Th>{t("date")}</Th><Th>{t("arrival")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th><Th>{t("account")}</Th><Th>{t("included")}</Th><Th>{t("recon")}</Th><Th>{t("organiser")}</Th></tr></thead>
            <tbody>{data.items.map((p) => <Tr key={p.id}>
              <Td><Link href={`/accounting/transactions?payoutId=${p.payoutId}`} className="underline-offset-4 hover:underline"><code className="text-xs">{p.payoutId}</code></Link>{!p.automatic && <span className="block text-xs text-muted">{t("manual")}</span>}</Td>
              <Td className="whitespace-nowrap text-muted">{fmtDate(p.stripeCreatedAt, locale, { dateStyle: "medium" })}</Td><Td className="whitespace-nowrap">{p.arrivalDate ? fmtDate(p.arrivalDate, locale, { dateStyle: "medium" }) : "—"}</Td>
              <Td className="text-end"><Money v={p.amount} c={p.currency} strong /></Td><Td><Badge s={p.status} />{p.failureMessage && <span className="block text-xs text-muted">{p.failureMessage}</span>}</Td>
              <Td><code className="text-xs">{p.stripeAccountId ?? "—"}</code></Td><Td>{p.includedCount ?? "—"}{p.includedNet != null && <span className="block text-xs text-muted"><Money v={p.includedNet} c={p.currency} /></span>}</Td><Td><Badge s={p.reconciliationStatus} /></Td>
              <Td className="min-w-44">{p.linkedPayments.length ? p.linkedPayments.map((l) => <span key={l.id} className="block text-sm"><span className="font-medium">{l.organiser}</span>{l.eventCode && <code className="ms-1 text-xs text-muted">{l.eventCode}</code>}{l.amount !== p.amount && <span className="ms-1 text-xs text-muted"><Money v={l.amount} c={l.currency} /></span>}</span>)
                : can("accounting.manage") && !["failed", "canceled"].includes(p.status) ? <Button size="sm" onClick={() => setLink(p)}><Link2 className="size-3.5" aria-hidden />{t("link")}</Button> : <span className="text-muted">—</span>}</Td></Tr>)}</tbody></Table></TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>}
      </Card>
      <p className="mt-3 text-xs text-muted">{t("linkHelp")}</p>
      {link && <PaymentDialog open onClose={() => setLink(null)} onSaved={() => void reload()} mode={mode}
        prefill={{ amount: link.amount, currency: link.currency, paymentDate: (link.arrivalDate ?? link.stripeCreatedAt).slice(0, 10), bankReference: link.payoutId, method: "STRIPE_TRANSFER", notes: "Paid out through Stripe" }} />}
    </div>
  );
}
