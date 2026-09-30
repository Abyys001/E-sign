"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ArrowLeft, Check, Save, Send, ShieldAlert } from "lucide-react";
import { useMe } from "@/components/app/me";
import { PolicyEditor, type Catalogue, type Policy } from "@/components/intake/policy-editor";
import { ClauseSelector, type LibClause, type Sel } from "@/components/intake/clause-selector";
import { Button, LinkButton } from "@/components/ui/button";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errMsg, useApi } from "@/lib/api";

type Flag = { code: string; severity: string; message: string };
type Detail = { template: { id: string; name: string; agreementType: string; status: string }; versions: Array<{ id: string; version: number; published: boolean }> };
type VerData = {
  version: { id: string; version: number; published: boolean; jurisdiction: string; language: string; policyConfig: Policy };
  errors: string[]; warnings: string[]; flags: Flag[]; requiredVariables: string[]; selection: Array<Sel & { clause: LibClause | null }>; library: LibClause[];
  moneyFlow: Array<{ label: string; value: string }>; refundDecision: { ticket?: unknown; provenance?: string[]; label?: string } | null;
};
type Meta = Catalogue & { jurisdictions: Array<{ code: string; label: string; region: string }>; disclaimer: string };

export default function AgreementEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("intake.editor");
  const c = useTranslations("common");
  const toast = useToast();
  const { can } = useMe();
  const { data: meta } = useApi<Meta>("/api/agreement-types");
  const { data: detail, reload: reloadDetail } = useApi<Detail>(`/api/agreement-templates/${id}`);
  const latest = detail?.versions[0];
  const { data: ver, reload: reloadVer } = useApi<VerData>(latest ? `/api/agreement-templates/versions/${latest.id}` : null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [selection, setSelection] = useState<Sel[]>([]);
  const [jur, setJur] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "publish" | "version">("");
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => { if (ver) { setPolicy(ver.version.policyConfig); setSelection(ver.selection.map(({ clause: _c, ...s }) => s)); setJur(ver.version.jurisdiction); setDirty(false); } }, [ver]);
  const locked = !!ver?.version.published || !can("templates.edit");
  const selected = useMemo(() => new Set(selection.map((s) => s.clauseKey)), [selection]);

  const save = async (): Promise<boolean> => {
    if (!ver || !policy) return false;
    setBusy("save");
    try { await api(`/api/agreement-templates/versions/${ver.version.id}`, { method: "PATCH", json: { jurisdiction: jur, selection, policyConfig: policy } }); setDirty(false); await reloadVer(); return true; }
    catch (e) { toast("error", errMsg(e)); return false; } finally { setBusy(""); }
  };
  const publish = async () => {
    if (!ver || !(await save())) return;
    setBusy("publish"); setProblems([]);
    try { await api(`/api/agreement-templates/versions/${ver.version.id}/publish`, { method: "POST" }); toast("ok", t("published")); await reloadDetail(); await reloadVer(); }
    catch (e) { const d = e instanceof ApiError ? (e.details as { errors?: string[] } | undefined) : undefined; setProblems(d?.errors ?? [errMsg(e)]); } finally { setBusy(""); }
  };
  const newVersion = async () => { setBusy("version"); try { await api(`/api/agreement-templates/${id}/new-version`, { method: "POST" }); await reloadDetail(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(""); } };
  // Changing jurisdiction re-pins every selected clause to that jurisdiction's variant on the server, so it is saved immediately.
  const changeJurisdiction = async (code: string) => {
    if (!ver || !policy) return;
    setBusy("save");
    try { await api(`/api/agreement-templates/versions/${ver.version.id}`, { method: "PATCH", json: { jurisdiction: code, policyConfig: policy } }); await reloadVer(); toast("ok", t("repinned")); }
    catch (e) { toast("error", errMsg(e)); } finally { setBusy(""); }
  };

  if (!detail || !ver || !policy || !meta) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  const errors = [...problems, ...ver.errors];
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/templates/agreements" aria-label={c("back")} className="grid size-9 place-items-center rounded-xl hover:bg-surface-2"><ArrowLeft className="size-4 rtl:rotate-180" /></Link>
        <div className="min-w-0 flex-1"><h1 className="truncate text-xl font-semibold">{detail.template.name}</h1><p className="text-sm text-muted">{t("versionLine", { n: ver.version.version, state: ver.version.published ? t("statePublished") : t("stateDraft") })}</p></div>
        <div className="w-56"><Select aria-label={t("jurisdiction")} disabled={locked} value={jur} onChange={(e) => void changeJurisdiction(e.target.value)}>{meta.jurisdictions.map((j) => <option key={j.code} value={j.code}>{j.label}</option>)}</Select></div>
        {ver.version.published && can("templates.edit") && <Button loading={busy === "version"} onClick={newVersion}>{t("newVersion")}</Button>}
        {ver.version.published && can("intake.manage") && <LinkButton href="/templates/intake" variant="primary">{t("createForm")}</LinkButton>}
        {!locked && <><Button loading={busy === "save"} disabled={!dirty} onClick={() => void save().then((ok) => ok && toast("ok", t("saved")))}><Save className="size-4" aria-hidden />{c("save")}</Button><Button variant="primary" loading={busy === "publish"} onClick={publish}><Send className="size-4" aria-hidden />{t("publish")}</Button></>}
      </div>
      <div className="mb-4 space-y-2">
        <Callout tone="warn" icon={<ShieldAlert className="size-4" />}>{meta.disclaimer}</Callout>
        {errors.length > 0 && <Callout tone="warn" title={t("blocking")}><ul className="list-disc ps-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Callout>}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <ClauseSelector library={ver.library} jurisdiction={jur} region={meta.jurisdictions.find((j) => j.code === jur)?.region ?? "OTHER"} selection={selection} readOnly={locked} onChange={(s) => { setSelection(s); setDirty(true); }} />
        </div>
        <aside className="min-w-0 space-y-4">
          <div className="rounded-card border border-line bg-surface shadow-card"><PolicyEditor value={policy} readOnly={locked} catalogue={meta} onChange={(p) => { setPolicy(p); setDirty(true); }} /></div>
          <div className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 className="mb-2 text-sm font-semibold">{t("legalFlags")}</h2>
            {ver.flags.length === 0 ? <p className="text-sm text-muted">{t("noFlags")}</p> : <ul className="space-y-2">{ver.flags.map((f) => <li key={f.code} className="flex gap-2 text-sm"><AlertTriangle className={`mt-0.5 size-4 shrink-0 ${f.severity === "formalities" ? "text-danger" : "text-warn"}`} aria-hidden /><span>{f.message}</span></li>)}</ul>}
            {ver.warnings.length > 0 && <ul className="mt-3 list-disc space-y-1 ps-5 text-sm text-muted">{ver.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </div>
          <div className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 className="mb-2 text-sm font-semibold">{t("moneyFlow")}</h2>
            <ul className="space-y-1 text-sm text-muted">{ver.moneyFlow.map((m, i) => <li key={i} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0" aria-hidden />{m.label}: {m.value}</li>)}</ul>
          </div>
          <div className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 className="mb-2 text-sm font-semibold">{t("needsFromOrganiser")}</h2>
            <p className="mb-2 text-xs text-muted">{t("needsHint", { n: selected.size })}</p>
            <div className="flex flex-wrap gap-1.5">{ver.requiredVariables.map((v) => <code key={v} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{v}</code>)}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
