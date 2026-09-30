"use client";
import { useTranslations } from "next-intl";
import { Card, PageHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/feedback";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useApi } from "@/lib/api";

type V = { key: string; label: string; type: string; group: string; options?: string[] };

export default function VariablesPage() {
  const t = useTranslations("intake.variables");
  const { data } = useApi<{ variables: V[] }>("/api/agreement-types");
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      <Card>
        {!data ? <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div> : (
          <TableWrap><Table><thead><tr><Th>{t("cols.token")}</Th><Th>{t("cols.label")}</Th><Th>{t("cols.type")}</Th><Th>{t("cols.group")}</Th></tr></thead>
            <tbody>{data.variables.map((v) => <Tr key={v.key}><Td><code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{`{{${v.key}}}`}</code></Td><Td>{v.label}</Td><Td className="text-muted">{v.type}{v.options?.length ? ` (${v.options.join(", ")})` : ""}</Td><Td className="text-muted">{v.group}</Td></Tr>)}</tbody></Table></TableWrap>)}
      </Card>
    </div>
  );
}
