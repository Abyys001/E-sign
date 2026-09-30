"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { FileSignature, Plus } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type Row = { id: string; name: string; agreementType: string; status: string; updatedAt: string };
type Meta = { agreementTypes: Array<{ key: string; name: string; purpose: string }>; jurisdictions: Array<{ code: string; label: string; hasVariants: boolean }>; languages: Array<{ code: string; label: string }>; disclaimer: string };

export default function AgreementsPage() {
  const t = useTranslations("intake.agreements");
  const c = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const { can } = useMe();
  const { data, loading } = useApi<{ items: Row[] }>("/api/agreement-templates");
  const { data: meta } = useApi<Meta>("/api/agreement-types");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", agreementType: "ticketing_distribution", jurisdiction: "ENG", language: "en" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const type = meta?.agreementTypes.find((x) => x.key === f.agreementType);
  const create = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ id: string }>("/api/agreement-templates", { json: f }); router.push(`/templates/agreements/${r.id}`); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={can("templates.create") && <Button variant="primary" onClick={() => { setF({ name: type?.name ?? "", agreementType: "ticketing_distribution", jurisdiction: "ENG", language: "en" }); setErr(null); setOpen(true); }}><Plus className="size-4" aria-hidden />{t("new")}</Button>} />
      {meta && <div className="mb-4"><Callout tone="warn">{meta.disclaimer}</Callout></div>}
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div> : !data?.items.length ? <EmptyState icon={<FileSignature className="size-6" />} title={t("empty")} description={t("emptyDesc")} /> : (
          <TableWrap><Table><thead><tr><Th>{t("cols.name")}</Th><Th>{t("cols.type")}</Th><Th>{c("statusLabel")}</Th><Th>{t("cols.updated")}</Th></tr></thead>
            <tbody>{data.items.map((r) => (
              <Tr key={r.id}><Td><Link href={`/templates/agreements/${r.id}`} className="font-medium hover:underline">{r.name}</Link></Td>
                <Td className="text-muted">{meta?.agreementTypes.find((x) => x.key === r.agreementType)?.name ?? r.agreementType}</Td><Td>{r.status}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(r.updatedAt, locale)}</Td></Tr>))}</tbody></Table></TableWrap>)}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t("new")} footer={<><Button onClick={() => setOpen(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={create}>{c("create")}</Button></>}>
        <div className="space-y-4">
          <Field label={t("type")}>{(p) => <Select {...p} value={f.agreementType} onChange={(e) => { const k = e.target.value; setF({ ...f, agreementType: k, name: meta?.agreementTypes.find((x) => x.key === k)?.name ?? f.name }); }}>{meta?.agreementTypes.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>}</Field>
          {type && <p className="text-sm text-muted">{type.purpose}</p>}
          <Field label={t("name")} error={err} required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("jurisdiction")}>{(p) => <Select {...p} value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })}>{meta?.jurisdictions.map((j) => <option key={j.code} value={j.code}>{j.label}</option>)}</Select>}</Field>
            <Field label={t("language")}>{(p) => <Select {...p} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{meta?.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</Select>}</Field>
          </div>
        </div>
      </Modal>
    </div>
  );
}
