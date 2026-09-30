"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { useAuditLabel } from "@/components/contracts/audit-label";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { fmtDate, useApi } from "@/lib/api";

type E = { seq: number; eventType: string; occurredAt: string; ip: string | null; contractId: string | null; contractName: string | null; reference: string | null; userName: string | null; recipientId: string | null };
const GROUPS = ["contract", "recipient", "signature", "document", "otp", "auth", "webhook", "settings", "user", "template", "email", "sms", "retention", "admin"];

export default function AuditPage() {
  const t = useTranslations("app.audit");
  const label = useAuditLabel();
  const locale = useLocale();
  const ensure = useElevation();
  const { can } = useMe();
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading } = useApi<{ items: E[]; page: number; pageSize: number; total: number }>(`/api/audit?page=${page}&pageSize=50${type ? `&type=${type}` : ""}`);
  const exp = async () => { if (await ensure()) window.location.href = `/api/audit?format=csv${type ? `&type=${type}` : ""}`; };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label={t("filter")} className="w-auto min-w-44"><option value="">{t("filter")}</option>{GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}</Select>
        {can("audit.export") && <Button onClick={exp}><Download className="size-4" aria-hidden />{t("export")}</Button>}</>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : !data || data.items.length === 0 ? <EmptyState title={t("empty")} /> : (
          <><TableWrap><Table><thead><tr><Th>{t("time")}</Th><Th>{t("event")}</Th><Th>{t("actor")}</Th><Th>{t("contract")}</Th><Th>{t("ip")}</Th></tr></thead>
            <tbody>{data.items.map((e) => <Tr key={e.seq}><Td className="whitespace-nowrap text-muted">{fmtDate(e.occurredAt, locale, { dateStyle: "medium", timeStyle: "medium" })}</Td><Td className="font-medium">{label(e.eventType)}</Td><Td>{e.userName ?? (e.recipientId ? t("recipient") : t("system"))}</Td><Td>{e.contractId ? <Link href={`/contracts/${e.contractId}?tab=audit`} className="underline underline-offset-4">{e.contractName ?? e.reference}</Link> : "—"}</Td><Td className="num text-muted">{e.ip ?? "—"}</Td></Tr>)}</tbody></Table></TableWrap>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>)}
      </Card>
    </div>
  );
}
