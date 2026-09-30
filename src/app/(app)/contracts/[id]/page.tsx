"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Archive, BellRing, CheckCircle2, Copy, Download, Eye, FileCheck2, Mail, MoreHorizontal, PenLine, Pencil, Plus, Send, ShieldCheck, Trash2, UserRoundCog, XCircle } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { RecipientModal, type RecipientDto } from "@/components/contracts/recipient-modal";
import { useAuditLabel } from "@/components/contracts/audit-label";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dropdown } from "@/components/ui/dropdown";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { PdfViewer } from "@/components/ui/pdf-viewer";
import { RecipientDot, StatusBadge } from "@/components/ui/status";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, fmtDate, useApi } from "@/lib/api";

type Version = { id: string; version: number; kind: string; sha256: string; pageCount: number; changeReason: string | null; createdAt: string; locked: boolean };
type FieldRow = { id: string; recipientId: string; type: string; label: string; page: number; x: number; y: number; w: number; h: number; required: boolean; filledAt: string | null };
type Detail = {
  contract: { id: string; name: string; reference: string; status: string; contractType: string; message: string | null; signingOrder: string; expiresAt: string | null; createdAt: string; sentAt: string | null; completedAt: string | null; verificationId: string | null; currentVersionId: string | null; signingVersionId: string | null; finalVersionId: string | null; documentsPurgedAt: string | null; rev: number };
  creator: { name: string; email: string } | undefined; template: { name: string } | null; versions: Version[]; recipients: RecipientDto[]; fields: FieldRow[];
  emails: Array<{ id: string; template: string; toEmail: string; subject: string; status: string; error: string | null; attempts: number; sentAt: string | null; createdAt: string }>;
  sms: Array<{ id: string; template: string; toPhone: string; status: string; error: string | null; sentAt: string | null; createdAt: string }>;
  downloads: Array<{ id: string; artifact: string; userId: string | null; recipientId: string | null; ip: string | null; createdAt: string }>;
  certificate: { certificateId: string; finalDocumentHash: string } | null;
  reminders: Array<{ id: string; recipientId: string; kind: string; sentAt: string }>; actionable: string[];
  permissions: Record<"edit" | "send" | "cancel" | "remind" | "download" | "audit" | "override" | "delete", boolean>;
};
type Audit = { chain: { ok: boolean; count: number; brokenAtSeq?: number }; events: Array<{ seq: number; eventType: string; occurredAt: string; ip: string | null; userAgent: string | null; metadata: Record<string, unknown>; hash: string; recipientId: string | null; userId: string | null; documentHash: string | null }> };
type TabId = "overview" | "document" | "recipients" | "progress" | "activity" | "audit" | "messages" | "versions" | "downloads";
const OPEN = ["SENT", "DELIVERED", "VIEWED", "PARTIALLY_SIGNED", "AWAITING_SIGNATURE"];

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><ContractDetail id={id} /></Suspense>; }

function ContractDetail({ id }: { id: string }) {
  const t = useTranslations("contracts.detail");
  const c = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const ensure = useElevation();
  const { data, loading, error, reload } = useApi<Detail>(`/api/contracts/${id}`);
  const tab = (sp.get("tab") as TabId) || "overview";
  const setTab = (v: TabId) => router.replace(`/contracts/${id}?tab=${v}`, { scroll: false });
  const [dlg, setDlg] = useState<null | "send" | "cancel" | "void" | "delete">(null);
  const [reason, setReason] = useState("");
  const [recModal, setRecModal] = useState<{ open: boolean; rec: RecipientDto | null }>({ open: false, rec: null });

  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-96" /></div>;
  if (error || !data) return <EmptyState title={c("error.notFound")} description={error?.message} action={<LinkButton href="/contracts">{c("back")}</LinkButton>} />;
  const { contract: k, permissions: perm } = data;
  const draft = k.status === "DRAFT" || k.status === "READY_TO_SEND";
  const inFlight = OPEN.includes(k.status);
  const done = k.status === "COMPLETED";
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast("ok", ok); await reload(); } catch (e) { toast("error", errMsg(e)); throw e; } };
  const post = (p: string, json: unknown = {}) => api(`/api/contracts/${id}/${p}`, { json });

  const tabs: Array<{ id: TabId; label: string; count?: number }> = [
    { id: "overview", label: t("tabs.overview") }, { id: "document", label: t("tabs.document") }, { id: "recipients", label: t("tabs.recipients"), count: data.recipients.length },
    { id: "progress", label: t("tabs.progress") }, ...(perm.audit ? [{ id: "activity" as const, label: t("tabs.activity") }, { id: "audit" as const, label: t("tabs.audit") }] : []),
    { id: "messages", label: t("tabs.messages"), count: data.emails.length + data.sms.length }, { id: "versions", label: t("tabs.versions"), count: data.versions.length }, ...(perm.download ? [{ id: "downloads" as const, label: t("tabs.downloads") }] : []),
  ];
  const more = [
    ...(perm.override && inFlight ? [{ label: t("expireNow"), icon: <XCircle className="size-4" />, onSelect: async () => { if (await ensure()) await act(() => post("expire")); } }] : []),
    ...(perm.override && (inFlight || done) ? [{ label: t("void"), icon: <XCircle className="size-4" />, onSelect: async () => { if (await ensure()) setDlg("void"); } }] : []),
    ...(perm.edit && !["DRAFT", "READY_TO_SEND", ...OPEN].includes(k.status) && k.status !== "ARCHIVED" ? [{ label: t("archive"), icon: <Archive className="size-4" />, onSelect: () => act(() => post("archive")) }] : []),
    { label: c("copy") + " · " + t("info.reference"), icon: <Copy className="size-4" />, onSelect: () => { void navigator.clipboard.writeText(k.reference); toast("ok", c("copied")); } },
    { label: t("duplicate"), icon: <Copy className="size-4" />, onSelect: () => router.push(`/contracts/new?duplicate=${id}`) },
    ...(perm.delete && draft ? [{ label: t("delete"), icon: <Trash2 className="size-4" />, separatorBefore: true, onSelect: async () => { if (await ensure()) setDlg("delete"); } }] : []),
  ];

  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{k.name}<StatusBadge status={k.status} /></span>}
        description={<span className="num">{k.reference} · {k.contractType}</span>}
        actions={<>
          {draft && perm.edit && <LinkButton href={`/contracts/${id}/prepare`}><Pencil className="size-4" aria-hidden />{data.versions.length ? t("editFields") : t("prepare")}</LinkButton>}
          {draft && perm.send && k.status === "READY_TO_SEND" && <Button variant="primary" onClick={() => setDlg("send")}><Send className="size-4" aria-hidden />{t("send")}</Button>}
          {draft && perm.edit && k.status === "DRAFT" && <Button onClick={() => act(() => post("ready", { ready: true }))} variant={data.versions.length ? "primary" : "secondary"}><CheckCircle2 className="size-4" aria-hidden />{t("markReady")}</Button>}
          {draft && perm.edit && k.status === "READY_TO_SEND" && <Button onClick={() => act(() => post("ready", { ready: false }))}>{t("markDraft")}</Button>}
          {inFlight && perm.remind && <Button onClick={() => act(async () => { const r = await post("remind") as { reminded: number }; toast("ok", t("reminded", { count: r.reminded })); })}><BellRing className="size-4" aria-hidden />{t("remindAll")}</Button>}
          {inFlight && perm.cancel && <Button variant="danger" onClick={() => setDlg("cancel")}><XCircle className="size-4" aria-hidden />{t("cancel")}</Button>}
          {done && perm.download && <a href={`/api/contracts/${id}/download?artifact=final`} className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg hover:brightness-95"><Download className="size-4" aria-hidden />{t("download.final")}</a>}
          <Dropdown label={c("more")} items={more} trigger={<span className="grid size-10 place-items-center rounded-xl border border-line-strong bg-surface hover:bg-surface-2"><MoreHorizontal className="size-4" /></span>} />
        </>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={k.name} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-6">
        {tab === "overview" && <Overview d={data} id={id} locale={locale} />}
        {tab === "document" && <DocumentTab d={data} id={id} />}
        {tab === "recipients" && <RecipientsTab d={data} id={id} draft={draft} inFlight={inFlight} locale={locale} onAdd={() => setRecModal({ open: true, rec: null })} onEdit={(r) => setRecModal({ open: true, rec: r })} act={act} post={post} />}
        {tab === "progress" && <ProgressTab d={data} locale={locale} />}
        {(tab === "activity" || tab === "audit") && perm.audit && <AuditTab id={id} d={data} mode={tab} locale={locale} canExport={perm.audit} ensure={ensure} />}
        {tab === "messages" && <MessagesTab d={data} locale={locale} />}
        {tab === "versions" && <VersionsTab d={data} id={id} draft={draft} locale={locale} onDone={reload} />}
        {tab === "downloads" && <DownloadsTab d={data} id={id} locale={locale} />}
      </div>

      <RecipientModal open={recModal.open} onClose={() => setRecModal({ open: false, rec: null })} contractId={id} existing={recModal.rec} nextOrder={(data.recipients.reduce((m, r) => Math.max(m, r.signingOrder), 0) || 0) + 1} parallel={k.signingOrder === "PARALLEL"} onSaved={reload} />
      <ConfirmDialog open={dlg === "send"} onClose={() => setDlg(null)} title={t("sendTitle", { name: k.name })} description={t("sendDesc")} confirmLabel={t("sendNow")} danger={false} onConfirm={() => act(() => api(`/api/contracts/${id}/send`, { json: {}, method: "POST" }), t("sent"))} />
      <ConfirmDialog open={dlg === "delete"} onClose={() => setDlg(null)} title={t("deleteTitle")} description={t("deleteDesc")} confirmLabel={t("delete")} onConfirm={async () => { await api(`/api/contracts/${id}`, { method: "DELETE" }); router.push("/contracts"); }} />
      <Modal open={dlg === "cancel" || dlg === "void"} onClose={() => { setDlg(null); setReason(""); }} title={dlg === "void" ? t("voidTitle") : t("cancelTitle")} description={dlg === "void" ? t("voidDesc") : t("cancelDesc")} size="sm"
        footer={<><Button onClick={() => { setDlg(null); setReason(""); }}>{c("cancel")}</Button><Button variant="danger" disabled={dlg === "void" && reason.trim().length < 3} onClick={async () => { const d = dlg; try { await act(() => post(d === "void" ? "void" : "cancel", { reason: reason.trim() || undefined })); setDlg(null); setReason(""); } catch { /* toast shown */ } }}>{dlg === "void" ? t("void") : t("cancel")}</Button></>}>
        <Field label={dlg === "void" ? t("voidReason") : t("cancelReason")} required={dlg === "void"}>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
      </Modal>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4"><dt className="w-40 shrink-0 text-sm text-muted">{k}</dt><dd className="min-w-0 break-words text-sm">{v}</dd></div>;

function Overview({ d, id, locale }: { d: Detail; id: string; locale: string }) {
  const t = useTranslations("contracts.detail");
  const c = useTranslations("common");
  const tn = useTranslations("contracts.new");
  const { contract: k } = d;
  const ready = useApi<{ ready: boolean; issues: Array<{ code: string; message: string }> }>(k.status === "DRAFT" || k.status === "READY_TO_SEND" ? `/api/contracts/${id}/readiness` : null);
  const finalV = d.versions.find((v) => v.kind === "FINAL");
  const cur = d.versions.find((v) => v.id === (k.finalVersionId ?? k.signingVersionId ?? k.currentVersionId));
  const acting = d.recipients.filter((r) => r.role !== "CC");
  const signed = acting.filter((r) => r.status === "COMPLETED").length;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {k.documentsPurgedAt && <Callout tone="warn" title={t("docPurged")} />}
        {ready.data && <Callout tone={ready.data.ready ? "ok" : "info"} icon={ready.data.ready ? <CheckCircle2 className="size-5 shrink-0" /> : <ShieldCheck className="size-5 shrink-0" />} title={ready.data.ready ? t("readyOk") : t("readiness")}>{!ready.data.ready && <ul className="mt-1 list-disc ps-5">{ready.data.issues.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>}</Callout>}
        <Card><CardHeader title={c("statusLabel")} description={acting.length ? `${signed}/${acting.length}` : undefined} />
          <div className="p-5"><div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={signed} aria-valuemin={0} aria-valuemax={acting.length || 1}><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${acting.length ? (signed / acting.length) * 100 : 0}%` }} /></div>
            <ul className="mt-4 space-y-3">{d.recipients.map((r, i) => <li key={r.id} className="flex items-center gap-3"><RecipientDot index={i} name={r.name} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.name}</span><span className="block truncate text-xs text-muted">{r.email} · {c(`roles.${r.role}`)}</span></span><StatusBadge kind="recipient" status={r.status} /></li>)}</ul>
          </div></Card>
        {k.message && <Card className="p-5"><h3 className="text-sm font-semibold">{t("info.message")}</h3><p className="mt-1 whitespace-pre-wrap text-sm text-muted">{k.message}</p></Card>}
      </div>
      <Card className="h-fit"><CardHeader title={c("view")} />
        <dl className="divide-y divide-line px-5">
          <Row k={t("info.reference")} v={<span className="num">{k.reference}</span>} /><Row k={t("info.type")} v={k.contractType} />
          <Row k={t("info.sender")} v={d.creator?.name ?? "—"} /><Row k={t("info.created")} v={fmtDate(k.createdAt, locale)} />
          <Row k={t("info.sent")} v={fmtDate(k.sentAt, locale)} /><Row k={t("info.expires")} v={fmtDate(k.expiresAt, locale, { dateStyle: "medium" })} />
          {k.completedAt && <Row k={t("info.completed")} v={fmtDate(k.completedAt, locale)} />}
          <Row k={t("info.order")} v={k.signingOrder === "PARALLEL" ? tn("parallel") : tn("sequential")} />
          {d.template && <Row k={t("info.template")} v={d.template.name} />}
          {cur && <Row k={t("info.pages")} v={<span className="num">{cur.pageCount}</span>} />}
          {(finalV ?? cur) && <Row k={t("info.hash")} v={<code className="break-all text-xs">{(finalV ?? cur)!.sha256}</code>} />}
          {k.verificationId && done(k.status) && <Row k={t("info.verify")} v={<Link href={`/verify/${k.verificationId}`} target="_blank" className="underline underline-offset-4">/verify/{k.verificationId}</Link>} />}
        </dl></Card>
    </div>
  );
}
const done = (s: string) => s === "COMPLETED";

function DocumentTab({ d, id }: { d: Detail; id: string }) {
  const t = useTranslations("contracts.detail");
  const { contract: k } = d;
  const vid = k.finalVersionId ?? k.signingVersionId ?? k.currentVersionId;
  const idx = (rid: string) => d.recipients.findIndex((r) => r.id === rid);
  if (k.documentsPurgedAt) return <Callout tone="warn" title={t("docPurged")} />;
  if (!vid) return <EmptyState title={t("noDoc")} action={<LinkButton href={`/contracts/${id}/prepare`}>{t("prepare")}</LinkButton>} />;
  const showFields = !k.finalVersionId;
  return <PdfViewer src={`/api/contracts/${id}/document?version=${vid}`} overlay={(p) => showFields ? d.fields.filter((f) => f.page === p).map((f) => (
    <div key={f.id} title={`${f.label || f.type} — ${d.recipients[idx(f.recipientId)]?.name ?? ""}`} className="absolute flex items-center justify-center rounded-sm border-2 border-fg bg-surface/70 text-[10px]" style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, borderStyle: (["solid", "dashed", "dotted", "double"] as const)[Math.max(0, idx(f.recipientId)) % 4] }}>
      <span className="num me-1 font-semibold">{idx(f.recipientId) + 1}</span><span className="truncate">{f.label || f.type}</span></div>)) : null} />;
}

function RecipientsTab({ d, id, draft, inFlight, locale, onAdd, onEdit, act, post }: { d: Detail; id: string; draft: boolean; inFlight: boolean; locale: string; onAdd: () => void; onEdit: (r: RecipientDto) => void; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; post: (p: string, j?: unknown) => Promise<unknown> }) {
  const t = useTranslations("contracts.detail.recipients");
  const td = useTranslations("contracts.detail");
  const c = useTranslations("common");
  const [rm, setRm] = useState<RecipientDto | null>(null);
  const [re, setRe] = useState<RecipientDto | null>(null);
  const [nu, setNu] = useState({ name: "", email: "" });
  const perm = d.permissions;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><p className="text-sm text-muted">{!draft && t("locked")}</p>{draft && perm.edit && <Button variant="primary" onClick={onAdd}><Plus className="size-4" aria-hidden />{t("add")}</Button>}</div>
      {d.recipients.length === 0 ? <Card><EmptyState icon={<UserRoundCog className="size-6" />} title={t("none")} description={t("noneDesc")} action={draft && perm.edit ? <Button variant="primary" onClick={onAdd}>{t("add")}</Button> : undefined} /></Card> : (
        <ul className="space-y-3">{d.recipients.map((r, i) => {
          const waiting = d.actionable.includes(r.id);
          return (
            <li key={r.id}><Card className="flex flex-wrap items-center gap-4 p-4">
              <RecipientDot index={i} name={r.name} />
              <div className="min-w-48 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.name}</span><StatusBadge kind="recipient" status={r.status} />{waiting && inFlight && <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-xs">↻</span>}</div>
                <p className="text-sm text-muted">{r.email}{r.company ? ` · ${r.company}` : ""}</p>
                <p className="mt-1 text-xs text-muted">{c(`roles.${r.role}`)} · {c(`auth.${r.authLevel}`)}{d.contract.signingOrder === "SEQUENTIAL" ? ` · ${t("step", { n: r.signingOrder })}` : ""}{!r.required && r.role !== "CC" ? ` · ${c("optional")}` : ""}
                  {r.viewedAt ? ` · ${t("viewedAt", { date: fmtDate(r.viewedAt, locale) })}` : ""}{r.completedAt ? ` · ${t("signedAt", { date: fmtDate(r.completedAt, locale) })}` : ""}</p>
                {r.declineReason && <p className="mt-1 text-sm">{t("declinedWhy", { reason: r.declineReason })}</p>}</div>
              <div className="flex flex-wrap gap-2">
                {draft && perm.edit && <><Button size="sm" onClick={() => onEdit(r)}><Pencil className="size-3.5" aria-hidden />{c("edit")}</Button><Button size="sm" onClick={() => setRm(r)}><Trash2 className="size-3.5" aria-hidden />{c("remove")}</Button></>}
                {inFlight && perm.remind && waiting && <Button size="sm" onClick={() => act(async () => { await post("remind", { recipientId: r.id }); }, td("reminded", { count: 1 }))}><BellRing className="size-3.5" aria-hidden />{td("remind")}</Button>}
                {inFlight && perm.send && waiting && <Button size="sm" onClick={() => act(() => api(`/api/contracts/${id}/recipients/${r.id}/resend`, { method: "POST", json: {} }), t("resent"))}><Mail className="size-3.5" aria-hidden />{t("resend")}</Button>}
                {inFlight && perm.override && r.status !== "COMPLETED" && r.role !== "CC" && <Button size="sm" onClick={() => { setRe(r); setNu({ name: "", email: "" }); }}><UserRoundCog className="size-3.5" aria-hidden />{t("reassign")}</Button>}
              </div></Card></li>
          );
        })}</ul>
      )}
      <ConfirmDialog open={!!rm} onClose={() => setRm(null)} title={t("removeConfirm", { name: rm?.name ?? "" })} confirmLabel={c("remove")} onConfirm={() => act(() => api(`/api/contracts/${id}/recipients/${rm!.id}`, { method: "DELETE" }))} />
      <Modal open={!!re} onClose={() => setRe(null)} title={t("reassignTitle")} description={t("reassignDesc")} size="sm"
        footer={<><Button onClick={() => setRe(null)}>{c("cancel")}</Button><Button variant="primary" disabled={!nu.name || !nu.email} onClick={async () => { try { await act(() => api(`/api/contracts/${id}/recipients/${re!.id}/reassign`, { method: "POST", json: nu }), t("reassigned")); setRe(null); } catch { /* toast shown */ } }}>{t("reassign")}</Button></>}>
        <div className="space-y-4"><Field label={t("name")} required>{(p) => <Input {...p} value={nu.name} onChange={(e) => setNu((s) => ({ ...s, name: e.target.value }))} />}</Field><Field label={t("email")} required>{(p) => <Input {...p} type="email" value={nu.email} onChange={(e) => setNu((s) => ({ ...s, email: e.target.value }))} />}</Field></div>
      </Modal>
    </div>
  );
}

function ProgressTab({ d, locale }: { d: Detail; locale: string }) {
  const t = useTranslations("contracts.detail.progress");
  const c = useTranslations("common");
  const { contract: k } = d;
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [{ id: "created", icon: <FileCheck2 className="size-4" />, title: t("created"), meta: fmtDate(k.createdAt, locale), state: "done" }];
    out.push({ id: "sent", icon: <Send className="size-4" />, title: t("sent"), meta: k.sentAt ? fmtDate(k.sentAt, locale) : undefined, state: k.sentAt ? "done" : "current" });
    for (const r of d.recipients.filter((x) => x.role !== "CC")) {
      const st = r.status === "COMPLETED" ? "done" : r.status === "DECLINED" ? "done" : d.actionable.includes(r.id) ? "current" : "todo";
      out.push({ id: r.id, icon: r.status === "COMPLETED" ? <PenLine className="size-4" /> : r.status === "VIEWED" ? <Eye className="size-4" /> : r.status === "DECLINED" ? <XCircle className="size-4" /> : <Mail className="size-4" />, title: `${r.name} — ${c(`status.recipient.${r.status}`)}`, meta: [r.viewedAt && `${t("viewed")} ${fmtDate(r.viewedAt, locale)}`, r.completedAt && `${t("signed")} ${fmtDate(r.completedAt, locale)}`].filter(Boolean).join(" · ") || (st === "current" ? t("waiting") : undefined), detail: r.declineReason ?? undefined, state: st });
    }
    out.push({ id: "completed", icon: <CheckCircle2 className="size-4" />, title: t("completed"), meta: k.completedAt ? fmtDate(k.completedAt, locale) : undefined, state: k.completedAt ? "done" : "todo" });
    out.push({ id: "final", icon: <ShieldCheck className="size-4" />, title: t("final"), state: d.certificate ? "done" : "todo" });
    return out;
  }, [d, k, locale, t, c]);
  return <Card className="max-w-2xl p-6"><Timeline items={items} /></Card>;
}

function AuditTab({ id, d, mode, locale, ensure }: { id: string; d: Detail; mode: "activity" | "audit"; locale: string; canExport: boolean; ensure: () => Promise<boolean> }) {
  const t = useTranslations("contracts.detail.audit");
  const label = useAuditLabel();
  const { can } = useMe();
  const { data, loading } = useApi<Audit>(`/api/contracts/${id}/audit`);
  const [hashes, setHashes] = useState(false);
  const who = (e: Audit["events"][number]) => (e.recipientId ? d.recipients.find((r) => r.id === e.recipientId)?.name ?? t("recipient") : e.userId ? t("teamMember") : t("system"));
  if (loading || !data) return <Skeleton className="h-64" />;
  const events = mode === "activity" ? data.events.filter((e) => !["document.version_created", "signing.link_accessed", "otp.requested", "signing_request.created"].includes(e.eventType)) : data.events;
  const exp = async (f: "csv" | "json") => { if (await ensure()) window.location.href = `/api/contracts/${id}/audit?format=${f}`; };
  return (
    <div className="space-y-4">
      {mode === "audit" && <Callout tone={data.chain.ok ? "ok" : "warn"} icon={<ShieldCheck className="size-5 shrink-0" />} title={t("chain")}>{data.chain.ok ? t("intact", { count: data.chain.count }) : t("broken", { seq: data.chain.brokenAtSeq ?? 0 })}</Callout>}
      {mode === "audit" && <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hashes} onChange={(e) => setHashes(e.target.checked)} className="size-4 accent-[var(--color-5)]" />{t("showHash")}</label>
        {can("audit.export") && <div className="ms-auto flex gap-2"><Button size="sm" onClick={() => exp("csv")}><Download className="size-3.5" aria-hidden />{t("exportCsv")}</Button><Button size="sm" onClick={() => exp("json")}><Download className="size-3.5" aria-hidden />{t("exportJson")}</Button></div>}</div>}
      <Card><TableWrap><Table>
        <thead><tr><Th>{t("col.time")}</Th><Th>{t("col.event")}</Th><Th>{t("col.actor")}</Th>{mode === "audit" && <Th>IP</Th>}{mode === "audit" && <Th>{t("col.detail")}</Th>}{hashes && <Th>{t("col.hash")}</Th>}</tr></thead>
        <tbody>{events.map((e) => (
          <Tr key={e.seq}><Td className="whitespace-nowrap text-muted">{fmtDate(e.occurredAt, locale, { dateStyle: "medium", timeStyle: "medium" })}</Td><Td className="font-medium">{label(e.eventType)}</Td><Td>{who(e)}</Td>
            {mode === "audit" && <Td className="whitespace-nowrap text-muted num">{e.ip ?? "—"}</Td>}
            {mode === "audit" && <Td className="max-w-xs truncate text-xs text-muted" title={JSON.stringify(e.metadata)}>{Object.keys(e.metadata ?? {}).length ? JSON.stringify(e.metadata) : ""}</Td>}
            {hashes && <Td><code className="text-[10px]">{e.hash.slice(0, 16)}…</code></Td>}</Tr>))}</tbody>
      </Table></TableWrap></Card>
    </div>
  );
}

function MessagesTab({ d, locale }: { d: Detail; locale: string }) {
  const t = useTranslations("contracts.detail.messages");
  const td = useTranslations("contracts.detail");
  const em = useTranslations("app.dashboard.emailStatus");
  const sm = useTranslations("app.dashboard.smsStatus");
  return (
    <div className="space-y-6">
      <Card><CardHeader title={t("email")} />{d.emails.length === 0 ? <p className="p-5 text-sm text-muted">{t("none")}</p> : <TableWrap><Table><thead><tr><Th>{t("to")}</Th><Th>{t("template")}</Th><Th>{t("status")}</Th><Th>{t("sentAt")}</Th></tr></thead><tbody>{d.emails.map((m) => <Tr key={m.id}><Td>{m.toEmail}</Td><Td className="max-w-xs truncate">{m.subject}</Td><Td>{em.has(m.status as never) ? em(m.status as never) : m.status}{m.error && <span className="block text-xs text-muted">{m.error.slice(0, 120)}</span>}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(m.sentAt ?? m.createdAt, locale)}</Td></Tr>)}</tbody></Table></TableWrap>}</Card>
      <Card><CardHeader title={t("sms")} />{d.sms.length === 0 ? <p className="p-5 text-sm text-muted">{t("none")}</p> : <TableWrap><Table><thead><tr><Th>{t("to")}</Th><Th>{t("template")}</Th><Th>{t("status")}</Th><Th>{t("sentAt")}</Th></tr></thead><tbody>{d.sms.map((m) => <Tr key={m.id}><Td dir="ltr">{m.toPhone}</Td><Td>{m.template}</Td><Td>{sm.has(m.status as never) ? sm(m.status as never) : m.status}{m.error && <span className="block text-xs text-muted">{m.error.slice(0, 120)}</span>}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(m.sentAt ?? m.createdAt, locale)}</Td></Tr>)}</tbody></Table></TableWrap>}</Card>
      <Card><CardHeader title={td("reminders")} />{d.reminders.length === 0 ? <p className="p-5 text-sm text-muted">{td("noReminders")}</p> : <ul className="divide-y divide-line">{d.reminders.map((r) => <li key={r.id} className="flex justify-between px-5 py-3 text-sm"><span>{d.recipients.find((x) => x.id === r.recipientId)?.name} · {r.kind === "MANUAL" ? td("manual") : td("auto")}</span><time className="text-muted">{fmtDate(r.sentAt, locale)}</time></li>)}</ul>}</Card>
    </div>
  );
}

function VersionsTab({ d, id, draft, locale, onDone }: { d: Detail; id: string; draft: boolean; locale: string; onDone: () => Promise<void> }) {
  const t = useTranslations("contracts.detail.versions");
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const upload = async () => { setBusy(true); try { const f = new FormData(); f.set("file", file!); f.set("reason", reason); await api(`/api/contracts/${id}/document`, { form: f }); setFile(null); setReason(""); await onDone(); toast("ok", "OK"); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  return (
    <div className="space-y-6">
      <Card><CardHeader title={t("title")} />
        <ul className="divide-y divide-line">{d.versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3"><span className="num grid size-9 place-items-center rounded-lg bg-surface-2 text-sm font-semibold">{v.version}</span>
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{t("v", { n: v.version })} · {t(`kind.${v.kind}` as never)}{v.id === d.contract.signingVersionId && ` · ${t("current")}`}{v.id === d.contract.finalVersionId && ` · ${t("final")}`}</p><p className="truncate text-xs text-muted">{fmtDate(v.createdAt, locale)} · {v.pageCount}p · <code>{v.sha256.slice(0, 16)}…</code>{v.changeReason ? ` · ${v.changeReason}` : ""}</p></div>
            {!d.contract.documentsPurgedAt && <a className="text-sm underline underline-offset-4" href={`/api/contracts/${id}/document?version=${v.id}`} target="_blank" rel="noreferrer">{t("view")}</a>}</li>))}</ul></Card>
      {draft && d.permissions.edit && (
        <Card className="space-y-4 p-5"><h3 className="text-base font-semibold">{t("upload")}</h3><p className="text-sm text-muted">{t("uploadDesc")}</p>
          <input type="file" accept="application/pdf" aria-label={t("upload")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm file:me-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-2" />
          <Field label={t("reason")}>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
          <Button variant="primary" loading={busy} disabled={!file} onClick={upload}>{t("upload")}</Button></Card>
      )}
    </div>
  );
}

function DownloadsTab({ d, id, locale }: { d: Detail; id: string; locale: string }) {
  const t = useTranslations("contracts.detail.downloads");
  const td = useTranslations("contracts.detail.download");
  const tm = useTranslations("contracts.detail.audit");
  const { contract: k } = d;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        {([["source", true], ["final", !!k.finalVersionId], ["certificate", !!d.certificate]] as const).map(([a, ok]) => ok && <a key={a} href={`/api/contracts/${id}/download?artifact=${a}`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2"><Download className="size-4" aria-hidden />{td(a)}</a>)}
      </div>
      <Card>{d.downloads.length === 0 ? <p className="p-5 text-sm text-muted">{t("none")}</p> : <TableWrap><Table><thead><tr><Th>{t("what")}</Th><Th>{t("who")}</Th><Th>IP</Th><Th>{t("when")}</Th></tr></thead><tbody>{d.downloads.map((x) => <Tr key={x.id}><Td>{x.artifact}</Td><Td>{x.recipientId ? d.recipients.find((r) => r.id === x.recipientId)?.name ?? t("recipient")   : tm("teamMember")}</Td><Td className="num text-muted">{x.ip ?? "—"}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(x.createdAt, locale)}</Td></Tr>)}</tbody></Table></TableWrap>}</Card>
    </div>
  );
}
