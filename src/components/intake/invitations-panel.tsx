"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Ban, Copy, Eye, Mail, RotateCcw, Send } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button, LinkButton } from "@/components/ui/button";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errMsg, fmtDate, useApi } from "@/lib/api";

type Inv = { id: string; recipientName: string; recipientEmail: string; state: string; emailStatus: string | null; contractStage: string; contractId: string | null; sentAt: string; expiresAt: string; openCount: number; lastOpenedAt: string | null; submittedAt: string | null; generationStatus: string; generationError: string | null };
type Activity = {
  invitation: Inv & { authMode: string; workflow: string };
  overview: { totalOpens: number; uniqueSessions: number; uniqueDevices: number; uniqueIps: number; currentlyActive: boolean; started: boolean; draftSaved: boolean; submitted: boolean; approxActive: string; progress: { percent: number; sections: Array<{ key: string; title: string; status: string }> }; lastDevice: string | null; lastIp: string | null };
  sessions: Array<{ id: string; device: string; ip: string | null; firstSeenAt: string; lastSeenAt: string; visits: number; active: boolean }>;
  signals: Array<{ code: string; message: string; at: string }>;
  timeline: Array<{ at: string; type: string; label: string; source: string; detail?: string }>;
};
type Submission = { status: string; submittedAt: string | null; answers: Record<string, unknown>; schema: { sections: Array<{ key: string; title: string; fields: Array<{ key: string; label: string; type: string }> }> }; files: Array<{ id: string; field: string; name: string; size: number }>; contractId: string | null; generationStatus: string; generationError: string | null };
const PAGE = 20;

const show = (v: unknown): string => (v === undefined || v === null || v === "" ? "—" : typeof v === "object" ? Object.values(v as object).filter(Boolean).join(", ") : String(v));

export function InvitationsPanel({ formId, publishedVersionId }: { formId: string; publishedVersionId: string | null }) {
  const t = useTranslations("intake.invitations");
  const c = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const [page, setPage] = useState(1);
  const { data, loading, reload } = useApi<{ items: Inv[] }>(`/api/intake-forms/${formId}/invitations?page=${page}&pageSize=${PAGE}`);
  const [send, setSend] = useState(false);
  const [f, setF] = useState({ recipientName: "", recipientEmail: "", authMode: "NONE", passcode: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const submit = async () => {
    if (!publishedVersionId) return;
    setBusy(true); setErr(null);
    try { await api(`/api/intake-forms/${formId}/invitations`, { json: { formVersionId: publishedVersionId, recipientName: f.recipientName, recipientEmail: f.recipientEmail, authMode: f.authMode, ...(f.authMode === "PASSCODE" ? { passcode: f.passcode } : {}), ...(f.message ? { message: f.message } : {}) } }); toast("ok", t("sent")); setSend(false); await reload(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">{t("sub")}</p>
        {can("intake.send") && <Button variant="primary" disabled={!publishedVersionId} onClick={() => { setF({ recipientName: "", recipientEmail: "", authMode: "NONE", passcode: "", message: "" }); setErr(null); setSend(true); }}><Send className="size-4" aria-hidden />{t("send")}</Button>}
      </div>
      {!publishedVersionId && <div className="mb-3"><Callout tone="warn">{t("publishFirst")}</Callout></div>}
      <div className="rounded-card border border-line bg-surface shadow-card">
        {loading && !data ? <div className="space-y-3 p-4">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div> : !data?.items.length ? <EmptyState icon={<Mail className="size-6" />} title={t("empty")} description={t("emptyDesc")} /> : (
          <><TableWrap><Table><thead><tr><Th>{t("cols.recipient")}</Th><Th>{t("cols.state")}</Th><Th>{t("cols.email")}</Th><Th>{t("cols.opens")}</Th><Th>{t("cols.contract")}</Th><Th>{t("cols.sent")}</Th><Th><span className="sr-only">{c("actions")}</span></Th></tr></thead>
            <tbody>{data.items.map((r) => (
              <Tr key={r.id}><Td><button type="button" onClick={() => setOpen(r.id)} className="text-start font-medium hover:underline">{r.recipientName}</button><span className="block text-xs text-muted">{r.recipientEmail}</span></Td>
                <Td>{t(`state.${r.state}` as never)}</Td><Td className="text-muted">{r.emailStatus ?? "—"}</Td><Td className="num">{r.openCount}</Td>
                <Td className="text-muted">{t(`stage.${r.contractStage}` as never)}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(r.sentAt, locale)}</Td>
                <Td className="text-end"><Button size="sm" onClick={() => setOpen(r.id)}><Eye className="size-3.5" aria-hidden />{t("view")}</Button></Td></Tr>))}</tbody></Table></TableWrap>
            <Pagination page={page} pageSize={PAGE} total={data.items.length === PAGE ? page * PAGE + 1 : (page - 1) * PAGE + data.items.length} onPage={setPage} /></>)}
      </div>
      <Modal open={send} onClose={() => setSend(false)} title={t("send")} footer={<><Button onClick={() => setSend(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.recipientName.trim() || !f.recipientEmail.trim() || (f.authMode === "PASSCODE" && f.passcode.length < 6)} onClick={submit}>{t("send")}</Button></>}>
        <div className="space-y-4">
          <Field label={t("recipientName")} required error={err}>{(p) => <Input {...p} value={f.recipientName} onChange={(e) => setF({ ...f, recipientName: e.target.value })} maxLength={200} />}</Field>
          <Field label={t("recipientEmail")} required>{(p) => <Input {...p} type="email" value={f.recipientEmail} onChange={(e) => setF({ ...f, recipientEmail: e.target.value })} maxLength={254} />}</Field>
          <Field label={t("auth")} hint={t("authHint")}>{(p) => <Select {...p} value={f.authMode} onChange={(e) => setF({ ...f, authMode: e.target.value })}><option value="NONE">{t("authNone")}</option><option value="EMAIL_OTP">{t("authOtp")}</option><option value="PASSCODE">{t("authPasscode")}</option></Select>}</Field>
          {f.authMode === "PASSCODE" && <Field label={t("passcode")} hint={t("passcodeHint")}>{(p) => <Input {...p} type="text" autoComplete="off" value={f.passcode} onChange={(e) => setF({ ...f, passcode: e.target.value })} />}</Field>}
          <Field label={t("message")}>{(p) => <Textarea {...p} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={2000} />}</Field>
        </div>
      </Modal>
      {open && <InvitationDetail id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function InvitationDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("intake.detail");
  const c = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const { can } = useMe();
  const act = useApi<Activity>(`/api/invitations/${id}/activity`);
  const submitted = act.data?.overview.submitted ?? false;
  const sub = useApi<Submission>(submitted ? `/api/invitations/${id}/submission` : null);
  const [tab, setTab] = useState<"activity" | "answers">("activity");
  const [approve, setApprove] = useState(false);
  const [signers, setSigners] = useState({ bilitName: "", bilitEmail: "" });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const inv = act.data?.invitation;
  const run = async (k: string, fn: () => Promise<unknown>, okMsg: string) => { setBusy(k); try { await fn(); toast("ok", okMsg); await act.reload(); onChanged(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(""); } };
  const copyLink = () => run("link", async () => { const r = await api<{ url: string }>(`/api/invitations/${id}/link`, { method: "POST" }); await navigator.clipboard.writeText(r.url); }, t("linkCopied"));
  const doApprove = async () => {
    if (!inv) return; setBusy("approve"); setErr(null);
    try {
      await api(`/api/contracts/${inv.contractId}/approve-for-signature`, { json: { organiser: { name: inv.recipientName, email: inv.recipientEmail }, bilit: { name: signers.bilitName, email: signers.bilitEmail } } });
      toast("ok", t("approved")); setApprove(false); await act.reload(); onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : errMsg(e)); } finally { setBusy(""); }
  };
  const awaiting = inv && inv.contractId && ["AWAITING_REVIEW", "READY_TO_SEND"].includes(inv.contractStage);
  return (
    <Modal open onClose={onClose} size="xl" side title={inv?.recipientName ?? t("title")} description={inv?.recipientEmail}
      footer={<><Button onClick={onClose}>{c("close")}</Button></>}>
      {!act.data || !inv ? <Skeleton className="h-40" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium">{t(`state.${inv.state}` as never)}</span>
            <span className="text-sm text-muted">{t(`stage.${inv.contractStage}` as never)}</span>
            <div className="ms-auto flex flex-wrap gap-2">
              {can("intake.send") && !["REVOKED", "SUBMITTED"].includes(inv.state) && <><Button size="sm" loading={busy === "link"} onClick={copyLink}><Copy className="size-3.5" aria-hidden />{t("copyLink")}</Button><Button size="sm" variant="danger" loading={busy === "revoke"} onClick={() => run("revoke", () => api(`/api/invitations/${id}/revoke`, { method: "POST" }), t("revoked"))}><Ban className="size-3.5" aria-hidden />{t("revoke")}</Button></>}
              {can("intake.send") && inv.state === "SUBMITTED" && <Button size="sm" loading={busy === "reopen"} onClick={() => run("reopen", () => api(`/api/invitations/${id}/reopen`, { json: { reason: "Reopened for amendment" } }), t("reopened"))}><RotateCcw className="size-3.5" aria-hidden />{t("reopen")}</Button>}
              {inv.contractId && <LinkButton size="sm" href={`/contracts/${inv.contractId}`}>{t("openContract")}</LinkButton>}
              {awaiting && can("contracts.send") && <Button size="sm" variant="primary" onClick={() => setApprove(true)}><Send className="size-3.5" aria-hidden />{t("approve")}</Button>}
            </div>
          </div>
          {inv.generationStatus === "FAILED" && <Callout tone="warn" title={t("genFailed")}>{inv.generationError}<div className="mt-2"><Button size="sm" loading={busy === "retry"} onClick={() => run("retry", () => api(`/api/invitations/${id}/retry-generation`, { method: "POST" }), t("retrying"))}>{t("retry")}</Button></div></Callout>}
          {inv.generationStatus === "HALTED" && <Callout tone="warn" title={t("halted")}>{t("haltedBody")}</Callout>}
          {inv.generationStatus === "QUEUED" || inv.generationStatus === "RUNNING" ? <Callout tone="info">{t("generating")}</Callout> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
            <div><p className="text-xs text-muted">{t("opens")}</p><p className="num text-lg font-semibold">{act.data.overview.totalOpens}</p></div>
            <div><p className="text-xs text-muted">{t("progress")}</p><p className="num text-lg font-semibold">{act.data.overview.progress.percent}%</p></div>
            <div><p className="text-xs text-muted">{t("activeTime")}</p><p className="text-lg font-semibold">{act.data.overview.approxActive}</p></div>
            <div><p className="text-xs text-muted">{t("lastDevice")}</p><p className="truncate">{act.data.overview.lastDevice ?? "—"}{act.data.overview.currentlyActive && <span className="ms-1 text-ok">●</span>}</p></div>
          </div>
          {act.data.signals.length > 0 && <Callout tone="warn" title={t("signals")}><ul className="list-disc ps-5">{act.data.signals.map((s, i) => <li key={i}>{s.message}</li>)}</ul><p className="mt-1 text-xs">{t("signalNote")}</p></Callout>}
          <div role="tablist" className="flex gap-1 border-b border-line">{(["activity", "answers"] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-accent font-medium" : "border-transparent text-muted"}`}>{t(`tab.${k}`)}</button>)}</div>
          {tab === "activity" && <ol className="space-y-2 text-sm">{[...act.data.timeline].reverse().map((e, i) => <li key={i} className="flex gap-3"><span className="w-40 shrink-0 text-muted">{fmtDate(e.at, locale)}</span><span>{e.label}{e.detail ? <span className="text-muted"> — {e.detail}</span> : null}</span></li>)}</ol>}
          {tab === "answers" && (!submitted ? <p className="text-sm text-muted">{t("notSubmitted")}</p> : !sub.data ? <Skeleton className="h-32" /> : (
            <div className="space-y-4">{sub.data.schema.sections.map((s) => <div key={s.key}><h3 className="mb-1 text-sm font-semibold">{s.title}</h3><dl className="divide-y divide-line rounded-xl border border-line text-sm">{s.fields.map((fl) => <div key={fl.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 px-3 py-2"><dt className="text-muted">{fl.label}</dt><dd className="break-words">{["file", "files"].includes(fl.type) ? sub.data!.files.filter((x) => x.field === fl.key).map((x) => <a key={x.id} className="me-2 underline" href={`/api/intake-files/${x.id}`}>{x.name}</a>) : show(sub.data!.answers[fl.key])}</dd></div>)}</dl></div>)}</div>))}
        </div>)}
      <Modal open={approve} onClose={() => setApprove(false)} title={t("approveTitle")} description={t("approveDesc")} footer={<><Button onClick={() => setApprove(false)}>{c("cancel")}</Button><Button variant="primary" loading={busy === "approve"} disabled={!signers.bilitName.trim() || !signers.bilitEmail.trim()} onClick={doApprove}>{t("approve")}</Button></>}>
        <div className="space-y-4"><Callout tone="info">{t("organiserSigner", { name: inv?.recipientName ?? "", email: inv?.recipientEmail ?? "" })}</Callout>
          <Field label={t("bilitName")} error={err} required>{(p) => <Input {...p} value={signers.bilitName} onChange={(e) => setSigners({ ...signers, bilitName: e.target.value })} />}</Field>
          <Field label={t("bilitEmail")} required>{(p) => <Input {...p} type="email" value={signers.bilitEmail} onChange={(e) => setSigners({ ...signers, bilitEmail: e.target.value })} />}</Field></div>
      </Modal>
    </Modal>
  );
}
