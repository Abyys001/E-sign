"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ClipboardList, Plus } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type Form = { id: string; title: string; status: string; updatedAt: string };
type Tpl = { id: string; name: string; status: string };
type Ver = { id: string; version: number; published: boolean };

export default function IntakeFormsPage() {
  const t = useTranslations("intake.forms");
  const c = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const { can } = useMe();
  const { data, loading } = useApi<{ items: Form[] }>("/api/intake-forms");
  const { data: tpls } = useApi<{ items: Tpl[] }>("/api/agreement-templates");
  const { data: wf } = useApi<{ workflows: Record<string, string> }>("/api/agreement-types");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", templateId: "", workflow: "B" });
  const [vers, setVers] = useState<Ver[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pickTemplate = async (id: string) => {
    setF((x) => ({ ...x, templateId: id })); setVers([]);
    if (!id) return;
    const d = await api<{ versions: Ver[] }>(`/api/agreement-templates/${id}`).catch(() => null);
    setVers(d?.versions.filter((v) => v.published) ?? []);
  };
  const create = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ id: string }>("/api/intake-forms", { json: { title: f.title, agreementTemplateVersionId: vers[0]!.id, workflow: f.workflow } }); router.push(`/templates/intake/${r.id}`); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={can("intake.manage") && <Button variant="primary" onClick={() => { setF({ title: "", templateId: "", workflow: "B" }); setVers([]); setErr(null); setOpen(true); }}><Plus className="size-4" aria-hidden />{t("new")}</Button>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div> : !data?.items.length ? <EmptyState icon={<ClipboardList className="size-6" />} title={t("empty")} description={t("emptyDesc")} /> : (
          <TableWrap><Table><thead><tr><Th>{t("cols.title")}</Th><Th>{c("statusLabel")}</Th><Th>{t("cols.updated")}</Th></tr></thead>
            <tbody>{data.items.map((r) => <Tr key={r.id}><Td><Link href={`/templates/intake/${r.id}`} className="font-medium hover:underline">{r.title}</Link></Td><Td>{r.status}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(r.updatedAt, locale)}</Td></Tr>)}</tbody></Table></TableWrap>)}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t("new")} footer={<><Button onClick={() => setOpen(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.title.trim() || !vers.length} onClick={create}>{c("create")}</Button></>}>
        <div className="space-y-4">
          <Field label={t("formTitle")} required error={err}>{(p) => <Input {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} />}</Field>
          <Field label={t("template")} required>{(p) => <Select {...p} value={f.templateId} onChange={(e) => void pickTemplate(e.target.value)}><option value="">—</option>{tpls?.items.filter((x) => x.status === "PUBLISHED").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          {f.templateId && !vers.length && <Callout tone="warn">{t("needsPublished")}</Callout>}
          <Field label={t("workflow")}>{(p) => <Select {...p} value={f.workflow} onChange={(e) => setF({ ...f, workflow: e.target.value })}>{Object.entries(wf?.workflows ?? {}).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}</Select>}</Field>
        </div>
      </Modal>
    </div>
  );
}
