"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Eye, Save, Send } from "lucide-react";
import { useMe } from "@/components/app/me";
import { FormAccess } from "@/components/intake/access-panel";
import { FormBuilder, type Coverage, type FieldDef, type FormSchemaT, type Settings } from "@/components/intake/form-builder";
import { InvitationsPanel } from "@/components/intake/invitations-panel";
import { Button } from "@/components/ui/button";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errMsg, useApi } from "@/lib/api";

type Ver = { id: string; version: number; published: boolean; workflow: string; schema: FormSchemaT; settings: Settings; agreementTemplateVersionId: string | null };
type Detail = { form: { id: string; title: string; status: string }; versions: Array<{ id: string; version: number; published: boolean }>; latest: Ver; validation: { errors: string[]; warnings: string[]; coverage: Coverage } | null };
type Meta = { fieldTypes: string[]; fieldPresets: Record<string, FieldDef>; workflows: Record<string, string> };
type Preview = { generates: string; template: { name: string; version: number }; jurisdiction: { label: string; warnings: string[] }; clauses: Array<{ key: string; title: string; version: number; reviewStatus: string }>; businessRules: { refundVariant: string; exclusivity: string; moneyFlow: Array<{ label: string; value: string }> }; flags: Array<{ code: string; message: string; severity: string }>; workflow: { code: string; label: string }; signers: { order: string; bilit: { name: string; email: string } | null } | null };

export default function IntakeFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("intake.page");
  const c = useTranslations("common");
  const toast = useToast();
  const { can } = useMe();
  const { data, reload } = useApi<Detail>(`/api/intake-forms/${id}`);
  const { data: meta } = useApi<Meta>("/api/agreement-types");
  const [tab, setTab] = useState<"builder" | "invitations" | "access">("builder");
  const [schema, setSchema] = useState<FormSchemaT | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [workflow, setWorkflow] = useState("B");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "publish" | "version">("");
  const [problems, setProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => { if (data) { setSchema(data.latest.schema); setSettings(data.latest.settings); setWorkflow(data.latest.workflow); setDirty(false); } }, [data]);
  const ver = data?.latest;
  const locked = !!ver?.published || !can("intake.manage");
  const publishedId = data?.versions.find((v) => v.published)?.id ?? null;

  const save = async () => {
    if (!ver || !schema || !settings) return false;
    setBusy("save");
    try { await api(`/api/intake-forms/${id}`, { method: "PATCH", json: { versionId: ver.id, schema, settings, workflow } }); setDirty(false); await reload(); return true; }
    catch (e) { const d = e instanceof ApiError ? (e.details as { problems?: string[] } | undefined) : undefined; toast("error", d?.problems?.[0] ?? errMsg(e)); return false; } finally { setBusy(""); }
  };
  const publish = async () => {
    if (!ver || !(await save())) return;
    setBusy("publish"); setProblems([]);
    try { await api(`/api/intake-forms/versions/${ver.id}/publish`, { method: "POST" }); toast("ok", t("published")); await reload(); }
    catch (e) { const d = e instanceof ApiError ? (e.details as { errors?: string[] } | undefined) : undefined; setProblems(d?.errors ?? [errMsg(e)]); } finally { setBusy(""); }
  };
  const openPreview = async () => { if (!ver) return; if (dirty && !(await save())) return; try { setPreview(await api<Preview>(`/api/intake-forms/versions/${ver.id}/preview`)); } catch (e) { toast("error", errMsg(e)); } };
  const newVersion = async () => { setBusy("version"); try { await api(`/api/intake-forms/${id}/new-version`, { method: "POST" }); await reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(""); } };

  if (!data || !ver || !schema || !settings || !meta) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  const errors = [...problems, ...(data.validation?.errors ?? [])];
  const tabs = [{ id: "builder" as const, label: t("tabs.builder") }, { id: "invitations" as const, label: t("tabs.invitations") }, ...(can("intake.view") ? [{ id: "access" as const, label: t("tabs.access") }] : [])];
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/templates/intake" aria-label={c("back")} className="grid size-9 place-items-center rounded-xl hover:bg-surface-2"><ArrowLeft className="size-4 rtl:rotate-180" /></Link>
        <div className="min-w-0 flex-1"><h1 className="truncate text-xl font-semibold">{data.form.title}</h1><p className="text-sm text-muted">{t("versionLine", { n: ver.version, state: ver.published ? t("statePublished") : t("stateDraft") })}</p></div>
        {tab === "builder" && <>
          <select aria-label={t("workflow")} disabled={locked} value={workflow} onChange={(e) => { setWorkflow(e.target.value); setDirty(true); }} className="h-10 max-w-64 rounded-xl border border-line bg-surface px-3 text-sm">{Object.entries(meta.workflows).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}</select>
          <Button onClick={openPreview}><Eye className="size-4" aria-hidden />{t("preview")}</Button>
          {ver.published && can("intake.manage") && <Button loading={busy === "version"} onClick={newVersion}>{t("newVersion")}</Button>}
          {!locked && <><Button loading={busy === "save"} disabled={!dirty} onClick={() => void save().then((ok) => ok && toast("ok", t("saved")))}><Save className="size-4" aria-hidden />{c("save")}</Button><Button variant="primary" loading={busy === "publish"} onClick={publish}><Send className="size-4" aria-hidden />{t("publish")}</Button></>}
        </>}
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("label")} />
      <div className="pt-4">
        {tab === "builder" && (<div className="space-y-4">
          {errors.length > 0 && <Callout tone="warn" title={t("blocking")}><ul className="list-disc ps-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Callout>}
          {(data.validation?.warnings ?? []).length > 0 && <Callout tone="info"><ul className="list-disc ps-5">{data.validation!.warnings.map((e, i) => <li key={i}>{e}</li>)}</ul></Callout>}
          <FormBuilder schema={schema} settings={settings} coverage={data.validation?.coverage ?? null} presets={meta.fieldPresets} fieldTypes={meta.fieldTypes} readOnly={locked} onSchema={(s) => { setSchema(s); setDirty(true); }} onSettings={(s) => { setSettings(s); setDirty(true); }} />
        </div>)}
        {tab === "invitations" && <InvitationsPanel formId={id} publishedVersionId={publishedId} />}
        {tab === "access" && <FormAccess formId={id} />}
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} size="xl" title={t("summaryTitle")} description={t("summaryDesc")} footer={<Button onClick={() => setPreview(null)}>{c("close")}</Button>}>
        {preview && (<div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-muted">{t("sum.generates")}</dt><dd className="font-medium">{preview.generates}</dd>
            <dt className="text-muted">{t("sum.template")}</dt><dd>{preview.template.name} · v{preview.template.version}</dd>
            <dt className="text-muted">{t("sum.jurisdiction")}</dt><dd>{preview.jurisdiction.label}</dd>
            <dt className="text-muted">{t("sum.workflow")}</dt><dd>{preview.workflow.code} — {preview.workflow.label}</dd>
            <dt className="text-muted">{t("sum.refund")}</dt><dd>{preview.businessRules.refundVariant}</dd>
            <dt className="text-muted">{t("sum.exclusivity")}</dt><dd>{preview.businessRules.exclusivity}</dd>
            {preview.signers && <><dt className="text-muted">{t("sum.signers")}</dt><dd>{preview.signers.bilit ? `${preview.signers.bilit.name} <${preview.signers.bilit.email}>` : "—"} · {preview.signers.order}</dd></>}
          </dl>
          {preview.jurisdiction.warnings.map((w, i) => <Callout key={i} tone="warn">{w}</Callout>)}
          {preview.flags.length > 0 && <Callout tone="warn" title={t("sum.flags")}><ul className="list-disc ps-5">{preview.flags.map((f) => <li key={f.code}>{f.message}</li>)}</ul></Callout>}
          <div><p className="mb-1 font-medium">{t("sum.money")}</p><ul className="list-disc ps-5 text-muted">{preview.businessRules.moneyFlow.map((m, i) => <li key={i}>{m.label}: {m.value}</li>)}</ul></div>
          <div><p className="mb-1 font-medium">{t("sum.clauses", { n: preview.clauses.length })}</p><ul className="columns-2 gap-6 text-muted">{preview.clauses.map((cl) => <li key={cl.key} className="break-inside-avoid">{cl.title} <span className="text-xs">v{cl.version}</span></li>)}</ul></div>
        </div>)}
      </Modal>
    </div>
  );
}
