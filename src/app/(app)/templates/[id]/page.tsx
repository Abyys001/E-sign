"use client";
import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Braces, Loader2, Plus, Save, Send, Trash2, UploadCloud, Users } from "lucide-react";
import { FieldEditor } from "@/components/editor/field-editor";
import { fromKit, toApi, type EditorField } from "@/components/editor/model";
import { Button } from "@/components/ui/button";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type Variable = { key: string; label: string; type: string; required: boolean; default?: string };
type Role = { key: string; name: string; role: string; order: number; required: boolean; defaultName?: string; defaultEmail?: string };
type Version = { id: string; version: number; published: boolean; variables: Variable[]; recipientRoles: Role[]; fields: Array<Parameters<typeof fromKit>[0]>; storageObjectId: string | null };
type Detail = { template: { id: string; name: string; contractType: string; status: string }; versions: Version[] };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "r$1").slice(0, 30);

export default function TemplateEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("contracts.templates.editor");
  const tt = useTranslations("contracts.templates");
  const c = useTranslations("common");
  const toast = useToast();
  const { data, reload } = useApi<Detail>(`/api/templates/${id}`);
  const [ver, setVer] = useState<number | null>(null);
  const [fields, setFields] = useState<EditorField[]>([]);
  const [vars, setVars] = useState<Variable[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "publish">("");
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"vars" | "roles" | null>(null);
  const [pdfRev, setPdfRev] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = data?.versions.find((v) => v.version === ver) ?? null;
  useEffect(() => {
    if (!data) return;
    const v = data.versions.find((x) => x.version === ver) ?? data.versions.find((x) => !x.published) ?? data.versions.at(-1)!;
    if (v && v.version !== ver) { setVer(v.version); setFields((v.fields ?? []).map(fromKit)); setVars(v.variables ?? []); setRoles(v.recipientRoles ?? []); setDirty(false); }
  }, [data, ver]);

  if (!data || !current) return <Skeleton className="h-[70vh]" />;
  const locked = current.published || data.template.status === "ARCHIVED";
  const mark = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };
  const parties = roles.map((r) => ({ id: r.key, name: r.name, sub: r.role }));

  const save = async (): Promise<boolean> => {
    setBusy("save"); setErr(null);
    try { await api(`/api/templates/${id}/versions/${current.version}`, { method: "PATCH", json: { variables: vars, recipientRoles: roles, fields: fields.map(toApi) } }); setDirty(false); toast("ok", t("saved")); return true; }
    catch (e) { setErr(errMsg(e)); return false; } finally { setBusy(""); }
  };
  const publish = async () => {
    if (dirty && !(await save())) return;
    setBusy("publish");
    try { await api(`/api/templates/${id}/publish`, { json: { version: current.version } }); toast("ok", t("published", { n: current.version })); await reload(); setVer(null); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
  };
  const newVersion = async () => { try { await api(`/api/templates/${id}/versions`, { method: "POST", json: {} }); setVer(null); await reload(); } catch (e) { toast("error", errMsg(e)); } };
  const replacePdf = async (f: File | undefined) => { if (!f) return; try { const form = new FormData(); form.set("file", f); form.set("version", String(current.version)); await api(`/api/templates/${id}/pdf`, { method: "PUT", form }); setPdfRev((n) => n + 1); await reload(); } catch (e) { toast("error", errMsg(e)); } };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/templates" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t("back")}</Link>
        <h1 className="min-w-0 truncate text-lg font-semibold">{data.template.name}</h1>
        <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs">{t("version", { n: current.version })}{!current.published && ` · ${t("draft")}`}</span>
        {data.versions.length > 1 && <Select aria-label={t("version", { n: "" })} value={current.version} onChange={(e) => { const v = data.versions.find((x) => x.version === Number(e.target.value))!; setVer(v.version); setFields((v.fields ?? []).map(fromKit)); setVars(v.variables ?? []); setRoles(v.recipientRoles ?? []); setDirty(false); }} className="w-auto">{data.versions.map((v) => <option key={v.id} value={v.version}>{t("version", { n: v.version })}{v.published ? "" : ` · ${t("draft")}`}</option>)}</Select>}
        <span role="status" className="ms-auto flex items-center gap-2 text-sm text-muted">{busy === "save" && <Loader2 className="size-4 animate-spin" aria-hidden />}{dirty ? t("dirty") : t("clean")}</span>
        {!locked && <>
          <Button onClick={() => setDlg("roles")}><Users className="size-4" aria-hidden />{t("roles")}</Button><Button onClick={() => setDlg("vars")}><Braces className="size-4" aria-hidden />{t("variables")}</Button>
          <input ref={fileRef} type="file" accept="application/pdf" className="sr-only" aria-label={t("replacePdf")} onChange={(e) => replacePdf(e.target.files?.[0])} /><Button onClick={() => fileRef.current?.click()}><UploadCloud className="size-4" aria-hidden />{t("replacePdf")}</Button>
          <Button onClick={() => void save()} loading={busy === "save"} disabled={!dirty}><Save className="size-4" aria-hidden />{t("save")}</Button>
          <Button variant="primary" onClick={publish} loading={busy === "publish"}><Send className="size-4" aria-hidden />{t("publish")}</Button></>}
        {current.published && data.template.status !== "ARCHIVED" && <Button variant="primary" onClick={newVersion}><Plus className="size-4" aria-hidden />{t("newVersion")}</Button>}
      </div>
      {locked && <div className="mb-3"><Callout title={t("readonly", { n: current.version })} /></div>}
      {err && <div className="mb-3"><Callout tone="warn" title={err} /></div>}
      {!current.storageObjectId ? <EmptyState icon={<UploadCloud className="size-6" />} title={t("noDoc")} action={<Button variant="primary" onClick={() => fileRef.current?.click()}>{t("replacePdf")}</Button>} />
        : <FieldEditor key={`${current.version}-${pdfRev}`} pdfUrl={`/api/templates/${id}/pdf?version=${current.version}&r=${pdfRev}`} parties={parties} partyLabel={t("roles")} value={fields} onChange={mark(setFields)} onAddParty={locked ? undefined : () => setDlg("roles")} readOnly={locked} />}

      <Modal open={dlg === "vars"} onClose={() => setDlg(null)} title={t("variables")} description={t("variablesHelp")} size="xl" footer={<Button variant="primary" onClick={() => setDlg(null)}>{t("done")}</Button>}>
        <div className="space-y-3">{vars.map((v, i) => (
          <div key={i} className="grid items-end gap-3 rounded-xl border border-line p-3 sm:grid-cols-[1fr_1fr_120px_1fr_auto_auto]">
            <Field label={t("varLabel")}>{(p) => <Input {...p} value={v.label} onChange={(e) => mark(setVars)(vars.map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.key && x.key !== slug(x.label) ? x.key : slug(e.target.value) } : x)))} />}</Field>
            <Field label={t("varKey")} hint={t("keyHint")}>{(p) => <Input {...p} dir="ltr" value={v.key} onChange={(e) => mark(setVars)(vars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />}</Field>
            <Field label={t("varType")}>{(p) => <Select {...p} value={v.type} onChange={(e) => mark(setVars)(vars.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>{["text", "date", "number", "currency"].map((k) => <option key={k} value={k}>{t(`types.${k}` as never)}</option>)}</Select>}</Field>
            <Field label={t("varDefault")}>{(p) => <Input {...p} value={v.default ?? ""} onChange={(e) => mark(setVars)(vars.map((x, j) => (j === i ? { ...x, default: e.target.value || undefined } : x)))} />}</Field>
            <Checkbox label={t("varRequired")} checked={v.required} onChange={(e) => mark(setVars)(vars.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
            <Button size="icon" aria-label={c("remove")} onClick={() => mark(setVars)(vars.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button></div>))}
          <Button onClick={() => mark(setVars)([...vars, { key: "", label: "", type: "text", required: true }])}><Plus className="size-4" aria-hidden />{t("addVariable")}</Button></div>
      </Modal>
      <Modal open={dlg === "roles"} onClose={() => setDlg(null)} title={t("roles")} description={t("rolesHelp")} size="xl" footer={<Button variant="primary" onClick={() => setDlg(null)}>{t("done")}</Button>}>
        <div className="space-y-3">{roles.map((r, i) => (
          <div key={i} className="grid items-end gap-3 rounded-xl border border-line p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_150px_90px_1fr_1fr_auto_auto]">
            <Field label={t("roleName")}>{(p) => <Input {...p} value={r.name} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, name: e.target.value, key: x.key && x.key !== slug(x.name) ? x.key : slug(e.target.value) } : x)))} />}</Field>
            <Field label={t("roleKey")} hint={t("keyHint")}>{(p) => <Input {...p} dir="ltr" value={r.key} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />}</Field>
            <Field label={t("roleType")}>{(p) => <Select {...p} value={r.role} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>{["SIGNER", "WITNESS", "APPROVER", "CC"].map((k) => <option key={k} value={k}>{c(`roles.${k}`)}</option>)}</Select>}</Field>
            <Field label={t("roleOrder")}>{(p) => <Input {...p} type="number" min={1} max={50} value={r.order} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, order: Math.max(1, Number(e.target.value) || 1) } : x)))} />}</Field>
            <Checkbox label={t("roleRequired")} checked={r.required} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
            <Field label={t("roleDefaultName")}>{(p) => <Input {...p} value={r.defaultName ?? ""} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, defaultName: e.target.value || undefined } : x)))} />}</Field>
            <Field label={t("roleDefaultEmail")}>{(p) => <Input {...p} type="email" dir="ltr" value={r.defaultEmail ?? ""} onChange={(e) => mark(setRoles)(roles.map((x, j) => (j === i ? { ...x, defaultEmail: e.target.value || undefined } : x)))} />}</Field>
            <Button size="icon" aria-label={c("remove")} onClick={() => { mark(setRoles)(roles.filter((_, j) => j !== i)); mark(setFields)(fields.filter((f) => f.partyId !== r.key)); }}><Trash2 className="size-4" /></Button></div>))}
          <Button onClick={() => mark(setRoles)([...roles, { key: `signer_${roles.length + 1}`, name: t("roleName", { n: roles.length + 1 }), role: "SIGNER", order: roles.length + 1, required: true }])}><Plus className="size-4" aria-hidden />{t("addRole")}</Button></div>
      </Modal>
      <span className="sr-only">{tt("title")}</span>
    </div>
  );
}
