"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { faBuildingColumns, faEye, faMoneyCheckDollar, faPen, faUserPlus, faUsers } from "@fortawesome/free-solid-svg-icons";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { Badge, Money, useMode } from "@/components/accounting/kit";
import { EmployeeDialog, Fa, type EmployeeRow } from "@/components/accounting/books";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

export default function EmployeesPage() {
  const t = useTranslations("accounting.books.emp");
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { q } = useMode();
  const { data, loading, reload } = useApi<{ items: EmployeeRow[] }>(can("accounting.payroll") ? q("/api/accounting/employees") : null);
  const [dlg, setDlg] = useState<EmployeeRow | "new" | null>(null);
  const [bank, setBank] = useState<Record<string, Record<string, string | null>>>({});
  if (!can("accounting.payroll")) return <EmptyState title={t("forbidden")} />;
  const reveal = async (id: string) => { if (!(await ensure())) return; try { const r = await api<{ bankDetails: Record<string, string | null> }>(`/api/accounting/employees/${id}?bank=1`); setBank((b) => ({ ...b, [id]: r.bankDetails })); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("sub")} actions={<Button variant="primary" onClick={() => setDlg("new")}><Fa icon={faUserPlus} />{t("add")}</Button>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          : !data?.items.length ? <EmptyState icon={<Fa icon={faUsers} className="text-2xl" />} title={t("empty")} description={t("emptyDesc")} action={<Button variant="primary" onClick={() => setDlg("new")}><Fa icon={faUserPlus} />{t("add")}</Button>} /> : (
          <TableWrap><Table><thead><tr><Th>{t("name")}</Th><Th>{t("country")}</Th><Th>{t("ids")}</Th><Th>{t("frequency")}</Th><Th className="text-end">{t("defaultGross")}</Th><Th className="text-end">{t("ytdGross")}</Th><Th>{t("bank")}</Th><Th>{t("status")}</Th><Th><span className="sr-only">{t("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((e) => <Tr key={e.id} className={e.active ? "" : "text-muted"}>
              <Td className="min-w-44"><span className="font-medium">{e.name}</span><span className="block text-xs text-muted">{[e.jobTitle, e.employeeRef, e.email].filter(Boolean).join(" · ")}</span></Td>
              <Td>{e.country} · <span className="uppercase">{e.currency}</span></Td>
              <Td className="text-xs">{e.taxId ?? "—"}<span className="block text-muted">{e.socialSecurityNo ?? "—"}</span></Td>
              <Td className="text-sm">{t(`freq.${e.payFrequency}`)}</Td>
              <Td className="text-end">{e.defaultGross != null ? <Money v={e.defaultGross} c={e.currency} /> : "—"}</Td>
              <Td className="text-end"><Money v={e.ytdGross} c={e.currency} strong />{e.lastPayDate && <span className="block text-xs text-muted">{t("lastPaid")} {e.lastPayDate}</span>}</Td>
              <Td className="text-xs">{bank[e.id] ? <span className="whitespace-pre-line">{Object.values(bank[e.id]!).filter(Boolean).join("\n")}</span> : e.hasBankDetails ? <span className="flex items-center gap-1.5"><Fa icon={faBuildingColumns} className="text-muted" />{e.bankHint}<Button size="sm" variant="ghost" aria-label={t("reveal")} onClick={() => reveal(e.id)}><Fa icon={faEye} className="text-xs" /></Button></span> : "—"}</Td>
              <Td><Badge s={e.active ? "ACTIVE" : "INACTIVE"} /></Td>
              <Td className="text-end"><div className="flex justify-end gap-1"><LinkButton size="sm" href={`/accounting/books/payslips?employeeId=${e.id}`}><Fa icon={faMoneyCheckDollar} className="text-xs" />{t("payslips")}</LinkButton><Button size="sm" variant="ghost" aria-label={t("edit")} onClick={() => setDlg(e)}><Fa icon={faPen} className="text-xs" /></Button></div></Td>
            </Tr>)}</tbody></Table></TableWrap>)}
      </Card>
      {dlg && <EmployeeDialog employee={dlg === "new" ? undefined : dlg} onClose={() => setDlg(null)} onSaved={() => void reload()} />}
    </div>
  );
}
