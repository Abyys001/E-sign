"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Copy, CreditCard, Download, FileText, Landmark, List, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";
import { api, errMsg, useApi } from "@/lib/api";
import { fmtDate } from "@/lib/api";
import { formatMoney, parseMajor } from "@/lib/money";

type Settings = { mode: string; connected: boolean; keyHint: string | null; financialAccountId: string | null; capabilities: { issuing: boolean; treasury: boolean; financialAccounts: Array<{ id: string; status: string; currency: string | null; balance: number | null }> } | null; lastTestedAt: string | null; lastError: string | null };
const TABS = ["cards", "staff", "requests", "expenses", "audit", "settings"] as const;

export default function TreasuryAdminPage() {
  const t = useTranslations("treasury.admin");
  const { mode, q } = useMode();
  const [tab, setTab] = useState<(typeof TABS)[number]>("cards");
  const settings = useApi<Settings>(q("/api/accounting/treasury/settings"));
  if (!settings.data) return <Skeleton className="h-64" />;
  const ready = settings.data.connected && settings.data.capabilities?.issuing;
  return (
    <div>
      <PageHeader title={t("title")} description={t("sub")} />
      {!ready && tab !== "settings" ? (
        <EmptyState icon={<CreditCard className="size-6" aria-hidden />} title={t("notSetUp", { mode: mode.toUpperCase() })} description={settings.data.connected && settings.data.capabilities && !settings.data.capabilities.issuing ? t("capNoIssuing") : t("notSetUpDesc")} action={<Button variant="primary" onClick={() => setTab("settings")}>{t("setUp")}</Button>} />
      ) : null}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((x) => <button key={x} type="button" onClick={() => setTab(x)} aria-current={tab === x ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition", tab === x ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>{t(`tabs.${x}`)}</button>)}
      </div>
      {tab === "settings" && <SettingsTab settings={settings} />}
      {tab === "cards" && ready && <CardsTab />}
      {tab === "staff" && ready && <StaffTab />}
      {tab === "requests" && ready && <RequestsTab />}
      {tab === "expenses" && ready && <ExpensesTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

// ---------- cards ----------
function CardsTab() {
  const t = useTranslations("treasury.admin.cards");
  const ti = useTranslations("treasury.intervals");
  const { q } = useMode();
  const toast = useToast();
  const ensure = useElevation();
  const cards = useApi<{ items: Array<{ id: string; brand: string | null; last4: string | null; currency: string; type: string; status: string; nickname: string | null; cardholderName: string; assignedStaffId: string | null; assignedStaffName: string | null; spendingLimits: Array<{ amount: number; interval: string }> }> }>(q("/api/accounting/treasury/cards"));
  const [activity, setActivity] = useState<string | null>(null); const [create, setCreate] = useState(false); const [assign, setAssign] = useState<string | null>(null); const [revoke, setRevoke] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const sync = async () => { setBusy(true); try { const r = await api<{ cards: number; cardholders: number }>(q("/api/accounting/treasury/cards/sync"), { method: "POST" }); toast("ok", t("synced", { cards: r.cards, cardholders: r.cardholders })); await cards.reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  const doRevoke = async () => { if (!revoke || !(await ensure())) return; try { await api(`/api/accounting/treasury/cards/${revoke}/revoke`, { method: "POST" }); toast("ok", "OK"); setRevoke(null); await cards.reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button loading={busy} onClick={sync}><RefreshCw className="size-4" aria-hidden />{t("sync")}</Button>
        <Button variant="primary" onClick={() => setCreate(true)}><Plus className="size-4" aria-hidden />{t("create")}</Button>
      </div>
      <Card>
        {!cards.data ? <Skeleton className="m-5 h-40" /> : !cards.data.items.length ? <p className="p-5 text-sm text-muted">{t("none")}</p> : (
          <TableWrap><Table>
            <thead><tr><Th>{t("card")}</Th><Th>{t("cardholder")}</Th><Th>{t("limits")}</Th><Th>{t("status")}</Th><Th>{t("assigned")}</Th><Th /></tr></thead>
            <tbody>{cards.data.items.map((c) => <Tr key={c.id}>
              <Td><span className="font-mono">•••• {c.last4 ?? "••••"}</span><span className="block text-xs text-muted">{c.nickname ?? c.brand} · {c.currency.toUpperCase()} · {c.type}</span></Td>
              <Td>{c.cardholderName}</Td>
              <Td className="text-xs">{c.spendingLimits.length ? c.spendingLimits.map((l, i) => <span key={i} className="block">{formatMoney(l.amount, c.currency)} / {ti(l.interval as "monthly")}</span>) : <span className="text-muted">—</span>}</Td>
              <Td><span className={cn("text-sm", c.status === "inactive" && "text-fin-warn", c.status === "canceled" && "text-fin-neg")}>{c.status}</span></Td>
              <Td>{c.assignedStaffName ? <span className="text-sm font-medium">{c.assignedStaffName}</span> : <span className="text-sm text-muted">{t("unassigned")}</span>}</Td>
              <Td><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setActivity(c.id)}><List className="size-4" aria-hidden />{t("activity")}</Button>{c.assignedStaffId ? <Button size="sm" variant="ghost" onClick={() => setRevoke(c.id)}>{t("revoke")}</Button> : <Button size="sm" onClick={() => setAssign(c.id)}>{t("assign")}</Button>}</div></Td>
            </Tr>)}</tbody>
          </Table></TableWrap>
        )}
      </Card>
      {create && <CreateCardDialog onClose={() => setCreate(false)} onDone={() => { setCreate(false); void cards.reload(); }} />}
      {activity && <CardActivityDialog cardId={activity} onClose={() => setActivity(null)} />}
      {assign && <AssignDialog cardId={assign} onClose={() => setAssign(null)} onDone={() => { setAssign(null); void cards.reload(); }} />}
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} onConfirm={doRevoke} title={t("revoke")} description={t("revokeConfirm")} confirmLabel={t("revoke")} danger />
    </div>
  );
}

function CreateCardDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("treasury.admin.createCard");
  const ti = useTranslations("treasury.intervals");
  const tc = useTranslations("treasury.common");
  const { mode, q } = useMode();
  const toast = useToast();
  const ensure = useElevation();
  const settings = useApi<Settings>(q("/api/accounting/treasury/settings"));
  const holders = useApi<{ items: Array<{ id: string; name: string }> }>(q("/api/accounting/treasury/cardholders"));
  const [useExisting, setUseExisting] = useState(true);
  const [cardholderId, setCardholderId] = useState("");
  const [ch, setCh] = useState({ name: "", email: "", type: "individual", line1: "", city: "", postalCode: "", country: "GB" });
  const [currency, setCurrency] = useState("gbp"); const [cardType, setCardType] = useState("virtual"); const [nickname, setNickname] = useState("");
  const [limits, setLimits] = useState<Array<{ amount: string; interval: string }>>([{ amount: "", interval: "monthly" }]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (holders.data && !cardholderId && holders.data.items[0]) setCardholderId(holders.data.items[0].id); if (holders.data && !holders.data.items.length) setUseExisting(false); }, [holders.data, cardholderId]);
  const fa = settings.data?.financialAccountId ?? null;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (!(await ensure())) return;
      let chId = cardholderId;
      if (!useExisting) { const r = await api<{ id: string }>("/api/accounting/treasury/cardholders", { json: { mode, name: ch.name, email: ch.email || null, type: ch.type, billing: { line1: ch.line1, city: ch.city, postalCode: ch.postalCode, country: ch.country } } }); chId = r.id; }
      const parsedLimits = limits.filter((l) => l.amount).map((l) => ({ amount: parseMajor(l.amount, currency), interval: l.interval }));
      await api("/api/accounting/treasury/cards", { json: { mode, cardholderId: chId, currency, type: cardType, nickname: nickname || null, financialAccountId: fa, limits: parsedLimits } });
      toast("ok", t("created")); onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open size="lg" onClose={onClose} title={t("title")} footer={<><Button onClick={onClose}>{tc("cancel")}</Button><Button variant="primary" loading={busy} onClick={submit}>{t("create")}</Button></>}>
      <div className="space-y-4">
        <div className="flex gap-2 text-sm">
          <button type="button" onClick={() => setUseExisting(true)} className={cn("rounded-lg border px-3 py-1.5", useExisting ? "border-fg font-medium" : "border-line text-muted")}>{t("existingCardholder")}</button>
          <button type="button" onClick={() => setUseExisting(false)} className={cn("rounded-lg border px-3 py-1.5", !useExisting ? "border-fg font-medium" : "border-line text-muted")}>{t("newCardholder")}</button>
        </div>
        {useExisting ? (
          <Field label={t("cardholder")}>{(p) => <Select {...p} value={cardholderId} onChange={(e) => setCardholderId(e.target.value)}>{holders.data?.items.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</Select>}</Field>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("name")}>{(p) => <Input {...p} value={ch.name} onChange={(e) => setCh({ ...ch, name: e.target.value })} />}</Field>
            <Field label={t("email")}>{(p) => <Input {...p} type="email" value={ch.email} onChange={(e) => setCh({ ...ch, email: e.target.value })} />}</Field>
            <Field label={t("line1")}>{(p) => <Input {...p} value={ch.line1} onChange={(e) => setCh({ ...ch, line1: e.target.value })} />}</Field>
            <Field label={t("city")}>{(p) => <Input {...p} value={ch.city} onChange={(e) => setCh({ ...ch, city: e.target.value })} />}</Field>
            <Field label={t("postalCode")}>{(p) => <Input {...p} value={ch.postalCode} onChange={(e) => setCh({ ...ch, postalCode: e.target.value })} />}</Field>
            <Field label={t("country")}>{(p) => <Input {...p} value={ch.country} maxLength={2} onChange={(e) => setCh({ ...ch, country: e.target.value.toUpperCase() })} className="uppercase" />}</Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("currency")}>{(p) => <Input {...p} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toLowerCase())} className="uppercase" />}</Field>
          <Field label={t("cardType")}>{(p) => <Select {...p} value={cardType} onChange={(e) => setCardType(e.target.value)}><option value="virtual">{t("virtual")}</option><option value="physical">{t("physical")}</option></Select>}</Field>
          <Field label={t("nickname")}>{(p) => <Input {...p} value={nickname} onChange={(e) => setNickname(e.target.value)} />}</Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">{t("limits")}</p>
          <div className="space-y-2">{limits.map((l, i) => <div key={i} className="flex gap-2"><Input inputMode="decimal" placeholder={t("amount")} value={l.amount} onChange={(e) => setLimits(limits.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /><Select value={l.interval} onChange={(e) => setLimits(limits.map((x, j) => j === i ? { ...x, interval: e.target.value } : x))} className="w-40">{["per_authorization", "daily", "weekly", "monthly", "yearly", "all_time"].map((iv) => <option key={iv} value={iv}>{ti(iv as "monthly")}</option>)}</Select></div>)}</div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setLimits([...limits, { amount: "", interval: "weekly" }])}><Plus className="size-4" aria-hidden />{t("addLimit")}</Button>
        </div>
        <p className="text-xs text-muted">{t("account")}: <span className="font-mono">{fa ?? "—"}</span></p>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

function AssignDialog({ cardId, onClose, onDone }: { cardId: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("treasury.admin.cards");
  const tc = useTranslations("treasury.common");
  const toast = useToast();
  const ensure = useElevation();
  const staff = useApi<{ items: Array<{ id: string; name: string; status: string; assignedCardId: string | null }> }>("/api/accounting/treasury/staff");
  const [staffId, setStaffId] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const eligible = staff.data?.items.filter((s) => s.status === "ACTIVE" || s.status === "INVITED") ?? [];
  useEffect(() => { if (eligible[0] && !staffId) setStaffId(eligible[0].id); }, [staff.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => { setBusy(true); setErr(null); try { if (!(await ensure())) return; await api(`/api/accounting/treasury/cards/${cardId}/assign`, { json: { staffId } }); toast("ok", "OK"); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title={t("assignTitle")} footer={<><Button onClick={onClose}>{tc("cancel")}</Button><Button variant="primary" loading={busy} disabled={!staffId} onClick={submit}>{t("assign")}</Button></>}>
      <Field label={t("assignStaff")} hint={t("assignHint")}>{(p) => <Select {...p} value={staffId} onChange={(e) => setStaffId(e.target.value)}>{eligible.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
      {err && <div className="mt-3"><Callout tone="warn">{err}</Callout></div>}
    </Modal>
  );
}

// ---------- staff ----------
function StaffTab() {
  const t = useTranslations("treasury.admin.staff");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const staff = useApi<{ items: Array<{ id: string; name: string; email: string; status: string; canFreezeCard: boolean; lastLoginAt: string | null; assignedLast4: string | null }> }>("/api/accounting/treasury/staff");
  const [add, setAdd] = useState(false); const [confirm, setConfirm] = useState<{ id: string; status: "SUSPENDED" | "REVOKED"; label: string; desc: string } | null>(null);
  const setStatus = async (id: string, status: string, elevate = false) => { try { if (elevate && !(await ensure())) return; await api(`/api/accounting/treasury/staff/${id}/status`, { json: { status } }); toast("ok", "OK"); await staff.reload(); } catch (e) { toast("error", errMsg(e)); } };
  const resend = async (id: string) => { try { const r = await api<{ inviteUrl: string }>(`/api/accounting/treasury/staff/${id}/resend`, { method: "POST" }); await navigator.clipboard?.writeText(r.inviteUrl).catch(() => {}); toast("ok", t("inviteCopied")); } catch (e) { toast("error", errMsg(e)); } };
  const toggleFreeze = async (id: string, canFreeze: boolean) => { try { await api(`/api/accounting/treasury/staff/${id}/freeze-policy`, { json: { canFreeze } }); toast("ok", t("freezePolicy")); await staff.reload(); } catch (e) { toast("error", errMsg(e)); } };
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button variant="primary" onClick={() => setAdd(true)}><Plus className="size-4" aria-hidden />{t("add")}</Button></div>
      <Card>
        {!staff.data ? <Skeleton className="m-5 h-40" /> : !staff.data.items.length ? <p className="p-5 text-sm text-muted">{t("none")}</p> : (
          <TableWrap><Table>
            <thead><tr><Th>{t("name")}</Th><Th>{t("status")}</Th><Th>{t("card")}</Th><Th>{t("canFreeze")}</Th><Th>{t("lastLogin")}</Th><Th /></tr></thead>
            <tbody>{staff.data.items.map((s) => <Tr key={s.id}>
              <Td><span className="font-medium">{s.name}</span><span className="block text-xs text-muted">{s.email}</span></Td>
              <Td><span className={cn("text-sm", s.status === "SUSPENDED" && "text-fin-warn", s.status === "REVOKED" && "text-fin-neg")}>{t(s.status as "ACTIVE")}</span></Td>
              <Td className="font-mono text-sm">{s.assignedLast4 ? `•••• ${s.assignedLast4}` : "—"}</Td>
              <Td><Checkbox checked={s.canFreezeCard} onChange={(e) => toggleFreeze(s.id, e.target.checked)} label="" /></Td>
              <Td className="text-sm text-muted">{s.lastLoginAt ? fmtDate(s.lastLoginAt, locale) : t("never")}</Td>
              <Td><div className="flex flex-wrap justify-end gap-1">
                {s.status !== "REVOKED" && <Button size="sm" variant="ghost" onClick={() => resend(s.id)}>{t("resend")}</Button>}
                {s.status === "ACTIVE" || s.status === "INVITED" ? <Button size="sm" variant="ghost" onClick={() => setConfirm({ id: s.id, status: "SUSPENDED", label: t("suspend"), desc: t("suspendConfirm") })}>{t("suspend")}</Button> : s.status === "SUSPENDED" ? <Button size="sm" variant="ghost" onClick={() => setStatus(s.id, "ACTIVE")}>{t("reactivate")}</Button> : null}
                {s.status !== "REVOKED" && <Button size="sm" variant="ghost" onClick={() => setConfirm({ id: s.id, status: "REVOKED", label: t("revoke"), desc: t("revokeConfirm") })}>{t("revoke")}</Button>}
              </div></Td>
            </Tr>)}</tbody>
          </Table></TableWrap>
        )}
      </Card>
      {add && <AddStaffDialog onClose={() => setAdd(false)} onDone={() => { setAdd(false); void staff.reload(); }} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={async () => { if (confirm) await setStatus(confirm.id, confirm.status, true); setConfirm(null); }} title={confirm?.label ?? ""} description={confirm?.desc ?? ""} confirmLabel={confirm?.label ?? ""} danger />
    </div>
  );
}

function AddStaffDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("treasury.admin.staff");
  const tc = useTranslations("treasury.common");
  const toast = useToast();
  const [v, setV] = useState({ name: "", email: "", canFreezeCard: false });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [link, setLink] = useState<string | null>(null);
  const submit = async () => { setBusy(true); setErr(null); try { const r = await api<{ inviteUrl: string }>("/api/accounting/treasury/staff", { json: v }); setLink(r.inviteUrl); toast("ok", t("created")); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <Modal open onClose={() => { if (link) onDone(); else onClose(); }} title={t("addTitle")} description={t("addSub")}
      footer={link ? <Button variant="primary" onClick={onDone}>{tc("close")}</Button> : <><Button onClick={onClose}>{tc("cancel")}</Button><Button variant="primary" loading={busy} disabled={!v.name || !v.email} onClick={submit}>{t("create")}</Button></>}>
      {link ? (
        <div className="space-y-3">
          <Callout tone="ok" title={t("inviteLink")}>{t("addSub")}</Callout>
          <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs">{link}</code><Button size="sm" onClick={() => { void navigator.clipboard?.writeText(link); toast("ok", t("inviteCopied")); }}><Copy className="size-4" aria-hidden />{t("inviteCopy")}</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label={t("name")}>{(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
          <Field label={t("email")}>{(p) => <Input {...p} type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />}</Field>
          <Checkbox checked={v.canFreezeCard} onChange={(e) => setV({ ...v, canFreezeCard: e.target.checked })} label={t("allowFreeze")} />
          {err && <Callout tone="warn">{err}</Callout>}
        </div>
      )}
    </Modal>
  );
}

// ---------- requests ----------
function RequestsTab() {
  const t = useTranslations("treasury.admin.requests");
  const ti = useTranslations("treasury.intervals");
  const tc = useTranslations("treasury.common");
  const toast = useToast();
  const ensure = useElevation();
  const reqs = useApi<{ items: Array<{ id: string; staffName: string; last4: string | null; interval: string; currentAmount: number | null; requestedAmount: number; currency: string; reason: string | null; status: string }> }>("/api/accounting/treasury/limit-requests?status=PENDING");
  const [decide, setDecide] = useState<{ id: string; approve: boolean } | null>(null); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => { if (!decide || !(await ensure())) return; setBusy(true); try { await api(`/api/accounting/treasury/limit-requests/${decide.id}/decide`, { json: { approve: decide.approve, note: note || null } }); toast("ok", decide.approve ? t("approved") : t("rejected")); setDecide(null); setNote(""); await reqs.reload(); } catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); } };
  return (
    <Card>
      {!reqs.data ? <Skeleton className="m-5 h-32" /> : !reqs.data.items.length ? <p className="p-5 text-sm text-muted">{t("none")}</p> : (
        <TableWrap><Table>
          <thead><tr><Th>{t("staff")}</Th><Th>{t("card")}</Th><Th>{t("interval")}</Th><Th className="text-end">{t("current")}</Th><Th className="text-end">{t("requested")}</Th><Th>{t("reason")}</Th><Th /></tr></thead>
          <tbody>{reqs.data.items.map((r) => <Tr key={r.id}>
            <Td className="font-medium">{r.staffName}</Td><Td className="font-mono text-sm">•••• {r.last4 ?? "••••"}</Td><Td>{ti(r.interval as "monthly")}</Td>
            <Td className="text-end">{r.currentAmount !== null ? formatMoney(r.currentAmount, r.currency) : "—"}</Td>
            <Td className="text-end font-semibold">{formatMoney(r.requestedAmount, r.currency)}</Td>
            <Td className="max-w-48 text-sm text-muted">{r.reason ?? "—"}</Td>
            <Td><div className="flex justify-end gap-1"><Button size="sm" variant="primary" onClick={() => setDecide({ id: r.id, approve: true })}>{t("approve")}</Button><Button size="sm" variant="ghost" onClick={() => setDecide({ id: r.id, approve: false })}>{t("reject")}</Button></div></Td>
          </Tr>)}</tbody>
        </Table></TableWrap>
      )}
      {decide && <Modal open onClose={() => setDecide(null)} title={decide.approve ? t("approve") : t("reject")} description={decide.approve ? t("approveConfirm") : t("rejectConfirm")} footer={<><Button onClick={() => setDecide(null)}>{tc("cancel")}</Button><Button variant={decide.approve ? "primary" : "secondary"} loading={busy} onClick={submit}>{decide.approve ? t("approve") : t("reject")}</Button></>}>
        <Field label={t("decideNote")}>{(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-16" />}</Field>
      </Modal>}
    </Card>
  );
}
// ---------- card activity (admin oversight) ----------
type AdminActivity = { id: string; kind: string; amount: number; currency: string; status: string; declined: boolean; merchant: string | null; category: string | null; createdAt: number; staffName: string | null; note: string | null; expenseId: string | null; hasReceipt: boolean };
function CardActivityDialog({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const t = useTranslations("treasury.admin.activity");
  const tc = useTranslations("treasury.common");
  const locale = useLocale();
  const a = useApi<{ card: { last4: string | null; brand: string | null; currency: string; status: string }; activity: AdminActivity[] }>(`/api/accounting/treasury/cards/${cardId}/activity`);
  return (
    <Modal open size="lg" onClose={onClose} title={a.data ? t("title", { last4: a.data.card.last4 ?? "••••" }) : t("loading")} description={t("sub")} footer={<Button onClick={onClose}>{tc("close")}</Button>}>
      {a.error ? <Callout tone="warn">{errMsg(a.error)}</Callout> : !a.data ? <Skeleton className="h-40" /> : !a.data.activity.length ? <p className="text-sm text-muted">{t("none")}</p> : (
        <TableWrap><Table>
          <thead><tr><Th>{t("date")}</Th><Th>{t("merchant")}</Th><Th>{t("staff")}</Th><Th>{t("status")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("note")}</Th></tr></thead>
          <tbody>{a.data.activity.map((x) => <Tr key={x.id}>
            <Td className="whitespace-nowrap text-muted">{fmtDate(new Date(x.createdAt * 1000).toISOString(), locale)}</Td>
            <Td>{x.merchant ?? "—"}<span className="block text-xs text-muted">{x.kind === "authorization" ? t("authorization") : t("transaction")}</span></Td>
            <Td className="text-sm">{x.staffName ?? "—"}</Td>
            <Td><span className={cn("text-xs", x.declined && "text-fin-neg")}>{x.declined ? t("declined") : x.status}</span></Td>
            <Td className="text-end font-medium">{formatMoney(Math.abs(x.amount), x.currency)}</Td>
            <Td className="max-w-48 text-xs text-muted">{x.note ?? ""}{x.hasReceipt && x.expenseId ? <a className="ms-1 inline-flex items-center gap-1 text-accent underline" href={`/api/accounting/treasury/receipts/${x.expenseId}`} target="_blank" rel="noreferrer"><FileText className="size-3.5" aria-hidden />{t("receipt")}</a> : null}</Td>
          </Tr>)}</tbody>
        </Table></TableWrap>
      )}
    </Modal>
  );
}

// ---------- expenses (review + export) ----------
function ExpensesTab() {
  const t = useTranslations("treasury.admin.expenses");
  const locale = useLocale();
  const { q } = useMode();
  const [page, setPage] = useState(1);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`); const [to, setTo] = useState(today);
  const ex = useApi<{ items: Array<{ id: string; stripeObjectId: string; note: string | null; receiptName: string | null; hasReceipt: boolean; staffName: string | null; last4: string | null; updatedAt: string }>; page: number; pageSize: number }>(q(`/api/accounting/treasury/expenses?page=${page}&pageSize=50`));
  const exportUrl = q(`/api/accounting/treasury/expenses/export?from=${from}&to=${to}`);
  return (
    <div className="space-y-4">
      <Card><CardHeader title={t("exportTitle")} description={t("exportDesc")} />
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label={t("from")}>{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label={t("to")}>{(p) => <Input {...p} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          <a href={exportUrl} className="inline-flex h-10 items-center gap-2 rounded-lg bg-fg px-4 text-sm font-medium text-bg hover:opacity-90"><Download className="size-4" aria-hidden />{t("export")}</a>
        </div>
      </Card>
      <Card><CardHeader title={t("title")} description={t("sub")} />
        {!ex.data ? <Skeleton className="m-5 h-32" /> : !ex.data.items.length ? <p className="p-5 text-sm text-muted">{t("none")}</p> : <>
          <TableWrap><Table>
            <thead><tr><Th>{t("updated")}</Th><Th>{t("staff")}</Th><Th>{t("card")}</Th><Th>{t("transaction")}</Th><Th>{t("note")}</Th><Th>{t("receipt")}</Th></tr></thead>
            <tbody>{ex.data.items.map((e) => <Tr key={e.id}>
              <Td className="whitespace-nowrap text-muted">{fmtDate(e.updatedAt, locale)}</Td>
              <Td className="font-medium">{e.staffName ?? "—"}</Td>
              <Td className="font-mono text-sm">•••• {e.last4 ?? "••••"}</Td>
              <Td className="font-mono text-xs text-muted">{e.stripeObjectId}</Td>
              <Td className="max-w-64 text-sm">{e.note ?? "—"}</Td>
              <Td>{e.hasReceipt ? <a className="inline-flex items-center gap-1 text-sm text-accent underline" href={`/api/accounting/treasury/receipts/${e.id}`} target="_blank" rel="noreferrer"><FileText className="size-4" aria-hidden />{e.receiptName ?? t("receipt")}</a> : <span className="text-sm text-muted">—</span>}</Td>
            </Tr>)}</tbody>
          </Table></TableWrap>
          <Pagination page={ex.data.page} pageSize={ex.data.pageSize} total={(ex.data.page - 1) * ex.data.pageSize + ex.data.items.length + (ex.data.items.length === ex.data.pageSize ? 1 : 0)} onPage={setPage} />
        </>}
      </Card>
    </div>
  );
}

// ---------- audit ----------
function AuditTab() {
  const t = useTranslations("treasury.admin.audit");
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const audit = useApi<{ items: Array<{ id: string; actorType: string; actorName: string | null; action: string; resource: string | null; resourceId: string | null; outcome: string; ip: string | null; createdAt: string }>; total: number; page: number; pageSize: number }>(`/api/accounting/treasury/audit?page=${page}&pageSize=50`);
  return (
    <Card>
      {!audit.data ? <Skeleton className="m-5 h-40" /> : !audit.data.items.length ? <p className="p-5 text-sm text-muted">{t("none")}</p> : <>
        <TableWrap><Table>
          <thead><tr><Th>{t("time")}</Th><Th>{t("actor")}</Th><Th>{t("action")}</Th><Th>{t("resource")}</Th><Th>{t("outcome")}</Th><Th>{t("ip")}</Th></tr></thead>
          <tbody>{audit.data.items.map((a) => <Tr key={a.id}>
            <Td className="whitespace-nowrap text-muted">{fmtDate(a.createdAt, locale)}</Td>
            <Td>{a.actorName ?? "—"}<span className="block text-xs text-muted">{t(a.actorType as "ADMIN")}</span></Td>
            <Td className="font-mono text-xs">{a.action}</Td>
            <Td className="text-xs text-muted">{a.resource}{a.resourceId ? ` · ${a.resourceId.slice(0, 12)}` : ""}</Td>
            <Td><span className={cn("text-xs font-medium", a.outcome === "DENY" && "text-fin-neg", a.outcome === "FAIL" && "text-fin-warn")}>{t(a.outcome as "OK")}</span></Td>
            <Td className="text-xs text-muted">{a.ip ?? "—"}</Td>
          </Tr>)}</tbody>
        </Table></TableWrap>
        <Pagination page={audit.data.page} pageSize={audit.data.pageSize} total={audit.data.total} onPage={setPage} />
      </>}
    </Card>
  );
}

// ---------- settings ----------
function SettingsTab({ settings }: { settings: ReturnType<typeof useApi<Settings>> }) {
  const t = useTranslations("treasury.admin.settings");
  const { mode } = useMode();
  const toast = useToast();
  const ensure = useElevation();
  const [apiKey, setApiKey] = useState(""); const [fa, setFa] = useState<string | null>(null); const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const d = settings.data;
  useEffect(() => { if (d) setFa(d.financialAccountId ?? ""); }, [d]);
  if (!d || fa === null) return <Skeleton className="h-48" />;
  const save = async (remove = false) => {
    setBusy(true); setErr(null);
    try { if ((remove || apiKey || webhook) && !(await ensure())) return; await api("/api/accounting/treasury/settings", { method: "PATCH", json: remove ? { mode, apiKey: null } : { mode, ...(apiKey ? { apiKey } : {}), ...(webhook ? { webhookSecret: webhook } : {}), financialAccountId: fa || null } }); setApiKey(""); setWebhook(""); toast("ok", remove ? t("removed") : t("saved")); await settings.reload(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Card><CardHeader title={t("title", { mode: mode.toUpperCase() })} description={t("desc")} />
      <div className="space-y-4 p-5">
        {d.capabilities && <div className="flex flex-wrap gap-2 text-xs">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1", d.capabilities.issuing ? "border-fin-pos/40 text-fin-pos" : "border-fin-neg/40 text-fin-neg")}><ShieldCheck className="size-3.5" aria-hidden />{t("issuing")}: {t(d.capabilities.issuing ? "enabled" : "disabled")}</span>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1", d.capabilities.treasury ? "border-fin-pos/40 text-fin-pos" : "border-fin-neg/40 text-fin-neg")}><Landmark className="size-3.5" aria-hidden />{t("treasury")}: {t(d.capabilities.treasury ? "enabled" : "disabled")}</span>
        </div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("key")} hint={d.keyHint ? t("keySet", { hint: d.keyHint }) : t("keyHint")}>{(p) => <Input {...p} type="password" autoComplete="off" placeholder={d.keyHint ? "••••••••" : mode === "live" ? "rk_live_…" : "rk_test_…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}</Field>
          <Field label={t("account")} hint={t("accountHint")}>{(p) => <Select {...p} value={fa} onChange={(e) => setFa(e.target.value)}>{!d.capabilities?.financialAccounts.length && <option value="">—</option>}{d.capabilities?.financialAccounts.map((f) => <option key={f.id} value={f.id}>{f.id}{f.currency ? ` · ${f.currency.toUpperCase()}` : ""}</option>)}</Select>}</Field>
          <Field label={t("webhook")} hint={t("webhookHint")}>{(p) => <Input {...p} type="password" autoComplete="off" placeholder="whsec_…" value={webhook} onChange={(e) => setWebhook(e.target.value)} />}</Field>
          <Field label={t("webhookUrl")}>{(p) => <Input {...p} readOnly value={`${origin}/api/webhooks/stripe-issuing`} onFocus={(e) => e.target.select()} />}</Field>
        </div>
        <div className="text-xs text-muted"><p className="font-medium">{t("permsTitle")}</p><ul className="ms-4 list-disc"><li>{t("perm1")}</li><li>{t("perm2")}</li></ul></div>
        {d.connected && !d.lastError && <p className="text-sm text-fin-pos">{t("connected", { at: d.lastTestedAt ? new Date(d.lastTestedAt).toLocaleString() : "—" })}</p>}
        {d.lastError && <Callout tone="warn">{d.lastError}</Callout>}
        {err && <Callout tone="warn">{err}</Callout>}
        <div className="flex flex-wrap justify-end gap-2">{d.connected && <Button variant="ghost" loading={busy} onClick={() => save(true)}>{t("remove")}</Button>}<Button variant="primary" loading={busy} onClick={() => save()}>{t("save")}</Button></div>
      </div>
    </Card>
  );
}
