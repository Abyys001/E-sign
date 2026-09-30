"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Archive, LayoutTemplate, MoreHorizontal, Plus, Trash2, Undo2, UploadCloud } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dropdown } from "@/components/ui/dropdown";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type Row = { id: string; name: string; contractType: string; status: string; updatedAt: string; latestVersion: number; publishedVersion: number | null; usage: number };

export default function TemplatesPage() {
  const t = useTranslations("contracts.templates");
  const c = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const { can } = useMe();
  const { data, loading, reload } = useApi<{ items: Row[] }>("/api/templates");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const create = async () => {
    setBusy(true); setErr(null);
    try { const f = new FormData(); f.set("name", name.trim()); if (type.trim()) f.set("contractType", type.trim()); if (file) f.set("file", file); const r = await api<{ id: string }>("/api/templates", { form: f }); toast("ok", t("created")); router.push(`/templates/${r.id}`); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} actions={can("templates.create") && <Button variant="primary" onClick={() => { setName(""); setType(""); setFile(null); setErr(null); setOpen(true); }}><Plus className="size-4" aria-hidden />{t("new")}</Button>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div> : !data?.items.length ? <EmptyState icon={<LayoutTemplate className="size-6" />} title={t("empty")} description={t("emptyDesc")} action={can("templates.create") ? <Button variant="primary" onClick={() => setOpen(true)}>{t("new")}</Button> : undefined} /> : (
          <TableWrap><Table><thead><tr><Th>{t("cols.name")}</Th><Th>{c("statusLabel")}</Th><Th>{t("cols.versions")}</Th><Th>{t("cols.used")}</Th><Th>{t("cols.updated")}</Th><Th><span className="sr-only">{c("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((r) => (
              <Tr key={r.id}><Td><Link href={`/templates/${r.id}`} className="font-medium hover:underline">{r.name}</Link><span className="block text-xs text-muted">{r.contractType}</span></Td>
                <Td>{t(`status.${r.status}` as never)}</Td><Td className="num text-muted">{r.publishedVersion ? t("published", { n: r.publishedVersion }) : t("draftOnly")}</Td><Td className="num text-muted">{t("uses", { count: r.usage })}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(r.updatedAt, locale)}</Td>
                <Td className="text-end"><div className="flex justify-end gap-2">
                  {r.publishedVersion && r.status !== "ARCHIVED" && can("contracts.create") && <Button size="sm" onClick={() => router.push(`/contracts/new?template=${r.id}`)}>{t("useIt")}</Button>}
                  <Dropdown label={c("more")} items={[
                    ...(can("templates.edit") ? [{ label: r.status === "ARCHIVED" ? t("restore") : t("archive"), icon: r.status === "ARCHIVED" ? <Undo2 className="size-4" /> : <Archive className="size-4" />, onSelect: async () => { try { await api(`/api/templates/${r.id}/archive`, { json: { archived: r.status !== "ARCHIVED" } }); await reload(); } catch (e) { toast("error", errMsg(e)); } } }] : []),
                    ...(can("templates.delete") ? [{ label: t("delete"), icon: <Trash2 className="size-4" />, onSelect: () => setDel(r) }] : []),
                  ]} trigger={<span className="grid size-9 place-items-center rounded-xl hover:bg-surface-2"><MoreHorizontal className="size-4" /></span>} /></div></Td></Tr>))}</tbody></Table></TableWrap>)}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={t("new")} footer={<><Button onClick={() => setOpen(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !file} onClick={create}>{c("create")}</Button></>}>
        <div className="space-y-4"><Field label={t("name")} error={err} required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />}</Field>
          <Field label={t("type")}>{(p) => <Input {...p} value={type} onChange={(e) => setType(e.target.value)} maxLength={60} />}</Field>
          <div><input ref={fileRef} type="file" accept="application/pdf" className="sr-only" aria-label={t("file")} onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name.replace(/\.pdf$/i, "")); }} />
            <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-line-strong p-4 text-start hover:bg-surface-2"><UploadCloud className="size-6" aria-hidden /><span className="text-sm">{file ? file.name : t("file")}</span></button></div></div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={t("deleteTitle")} description={t("deleteDesc")} confirmLabel={t("delete")} onConfirm={async () => { await api(`/api/templates/${del!.id}`, { method: "DELETE" }); await reload(); }} />
    </div>
  );
}
