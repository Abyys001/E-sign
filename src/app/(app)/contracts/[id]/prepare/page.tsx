"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, CheckCircle2, Loader2, Save, Send, UploadCloud } from "lucide-react";
import { RecipientModal, type RecipientDto } from "@/components/contracts/recipient-modal";
import { FieldEditor } from "@/components/editor/field-editor";
import { fromRow, toApi, type EditorField } from "@/components/editor/model";
import { Button, LinkButton } from "@/components/ui/button";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type Detail = { contract: { id: string; name: string; status: string; signingOrder: string; currentVersionId: string | null; signingVersionId: string | null }; recipients: RecipientDto[]; fields: Array<Parameters<typeof fromRow>[0]>; permissions: { edit: boolean; send: boolean } };
type Readiness = { ready: boolean; issues: Array<{ code: string; message: string }> };

export default function Prepare({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("editor");
  const td = useTranslations("contracts.detail");
  const router = useRouter();
  const toast = useToast();
  const { data, loading, reload } = useApi<Detail>(`/api/contracts/${id}`);
  const [fields, setFields] = useState<EditorField[] | null>(null);
  const [saved, setSaved] = useState<"saved" | "dirty" | "saving">("saved");
  const [err, setErr] = useState<string | null>(null);
  const [recModal, setRecModal] = useState(false);
  const [issues, setIssues] = useState<Readiness | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef<EditorField[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { if (data && fields === null) { setFields(data.fields.map(fromRow)); latest.current = data.fields.map(fromRow); } }, [data, fields]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!latest.current) return false;
    clearTimeout(timer.current); setSaved("saving"); setErr(null);
    const snapshot = latest.current;
    try { await api(`/api/contracts/${id}/fields`, { method: "PUT", json: { fields: snapshot.map(toApi) } }); setSaved(latest.current === snapshot ? "saved" : "dirty"); return true; }
    catch (e) { setErr(errMsg(e)); setSaved("dirty"); return false; }
  }, [id]);
  const onChange = (f: EditorField[]) => { setFields(f); latest.current = f; setSaved("dirty"); clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 2500); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (saved !== "saved") e.preventDefault(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [saved]);

  const check = async () => { if (!(await save())) return null; const r = await api<Readiness>(`/api/contracts/${id}/readiness`); setIssues(r); return r; };
  const finish = async () => {
    const r = await check(); if (!r) return;
    if (!r.ready) { toast("error", t("notReady")); return; }
    try { await api(`/api/contracts/${id}/ready`, { json: { ready: true } }); router.push(`/contracts/${id}`); } catch (e) { toast("error", errMsg(e)); }
  };
  const upload = async (file: File | undefined) => { if (!file) return; setUploading(true); try { const f = new FormData(); f.set("file", file); await api(`/api/contracts/${id}/document`, { form: f }); await reload(); setFields(null); } catch (e) { toast("error", errMsg(e)); } finally { setUploading(false); } };

  if (loading && !data) return <Skeleton className="h-[70vh]" />;
  if (!data || fields === null) return <Skeleton className="h-[70vh]" />;
  const k = data.contract;
  const editable = (k.status === "DRAFT" || k.status === "READY_TO_SEND") && data.permissions.edit;
  if (!editable) return <div className="mx-auto max-w-lg"><EmptyState title={t("locked")} action={<LinkButton href={`/contracts/${id}`}>{t("back")}</LinkButton>} /></div>;
  const vid = k.currentVersionId;
  const parties = data.recipients.filter((r) => r.role !== "CC").map((r) => ({ id: r.id, name: r.name, sub: r.email }));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href={`/contracts/${id}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t("back")}</Link>
        <h1 className="min-w-0 truncate text-lg font-semibold">{k.name}</h1><StatusBadge status={k.status} />
        <span role="status" className="ms-auto flex items-center gap-2 text-sm text-muted">{saved === "saving" && <Loader2 className="size-4 animate-spin" aria-hidden />}{saved === "saved" ? t("saved") : saved === "saving" ? t("saving") : t("unsaved")}</span>
        <span className="num text-sm text-muted">{t("fieldCount", { count: fields.length })}</span>
        <Button onClick={() => void save()} disabled={saved === "saved"}><Save className="size-4" aria-hidden />{t("save")}</Button>
        <Button onClick={() => void check()}><CheckCircle2 className="size-4" aria-hidden />{t("check")}</Button>
        <Button variant="primary" onClick={finish}><Send className="size-4" aria-hidden />{t("markReady")}</Button>
      </div>
      {err && <div className="mb-3"><Callout tone="warn" title={t("saveFailed")}>{err}</Callout></div>}
      {issues && <div className="mb-3"><Callout tone={issues.ready ? "ok" : "info"} title={issues.ready ? t("ready") : t("notReady")}>{!issues.ready && <ul className="list-disc ps-5">{issues.issues.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>}</Callout></div>}
      {!vid ? (
        <EmptyState icon={<UploadCloud className="size-6" />} title={t("noDoc")} description={t("noDocDesc")} action={<><input ref={fileRef} type="file" accept="application/pdf" className="sr-only" aria-label={t("upload")} onChange={(e) => upload(e.target.files?.[0])} /><Button variant="primary" loading={uploading} onClick={() => fileRef.current?.click()}>{uploading ? t("uploading") : t("upload")}</Button></>} />
      ) : (
        <FieldEditor pdfUrl={`/api/contracts/${id}/document?version=${vid}`} parties={parties} value={fields} onChange={onChange} onAddParty={() => setRecModal(true)} />
      )}
      <RecipientModal open={recModal} onClose={() => setRecModal(false)} contractId={id} existing={null} nextOrder={(data.recipients.reduce((m, r) => Math.max(m, r.signingOrder), 0) || 0) + 1} parallel={k.signingOrder === "PARALLEL"} onSaved={reload} />
      <span className="sr-only">{td("prepare")}</span>
    </div>
  );
}
