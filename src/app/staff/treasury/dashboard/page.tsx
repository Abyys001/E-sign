"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CreditCard, Loader2, LogOut, LockOpen, Paperclip, Plus, Receipt, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";
import { formatMoney, parseMajor, toDecimalString } from "@/lib/money";

type Card = { id: string; nickname: string | null; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; currency: string; type: string; status: string; frozen: boolean; canFreeze: boolean; spendingLimits: Array<{ amount: number; interval: string }>; cardholderName: string };
type Activity = { id: string; kind: string; amount: number; currency: string; status: string; merchant: string | null; category: string | null; createdAt: number; declined: boolean; note: string | null; hasReceipt: boolean };
type Session = { staff: { name: string; email: string; canFreezeCard: boolean }; csrf: string; cards: Card[] };

const INTERVALS = ["per_authorization", "daily", "weekly", "monthly", "yearly", "all_time"] as const;

export default function StaffDashboard() {
  const t = useTranslations("treasury.staff");
  const td = useTranslations("treasury.staff.dash");
  const ti = useTranslations("treasury.intervals");
  const router = useRouter();
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [card, setCard] = useState<Card | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [tab, setTab] = useState<"card" | "activity">("card");
  const [freezeTo, setFreezeTo] = useState<boolean | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<Activity | null>(null);
  const csrf = useRef("");

  const post = useCallback(async (url: string, bodyData?: unknown, isForm?: FormData) => {
    const res = await fetch(url, { method: "POST", headers: { "x-csrf-token": csrf.current, ...(isForm ? {} : { "content-type": "application/json" }) }, body: isForm ?? (bodyData !== undefined ? JSON.stringify(bodyData) : undefined) });
    if (res.status === 401) { router.replace("/staff/treasury/login"); throw new Error("unauth"); }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error?.message ?? "Request failed");
    return j;
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/staff/treasury/session");
      if (res.status === 401) { router.replace("/staff/treasury/login"); return; }
      const s: Session = await res.json();
      csrf.current = s.csrf;
      setSession(s); setCard(s.cards[0] ?? null);
    } finally { setLoading(false); }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  const loadActivity = useCallback(async () => {
    if (!card) return;
    setActivity(null);
    const res = await fetch(`/api/staff/treasury/cards/activity?cardId=${card.id}`);
    if (res.ok) { const j = await res.json(); setCard(j.card); setActivity(j.activity); }
  }, [card?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "activity" && card && activity === null) void loadActivity(); }, [tab, card, activity, loadActivity]);

  const logout = async () => { await fetch("/api/staff/treasury/logout", { method: "POST", headers: { "x-csrf-token": csrf.current } }).catch(() => {}); router.replace("/staff/treasury/login"); };
  const doFreeze = async () => {
    const freeze = freezeTo!; setFreezeTo(null);
    try { const r = await post("/api/staff/treasury/cards/freeze", { cardId: card!.id, freeze }); setCard((c) => c && { ...c, status: r.status, frozen: r.status === "inactive" }); toast("ok", freeze ? td("frozen") : td("active")); }
    catch (e) { toast("error", (e as Error).message); }
  };

  if (loading) return <div className="mx-auto max-w-3xl p-5"><Skeleton className="h-64" /></div>;
  if (!session) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-fg text-bg"><CreditCard className="size-5" aria-hidden /></span><div><p className="font-semibold leading-tight">{t("brand")}</p><p className="text-xs text-muted">{session.staff.name}</p></div></div>
        <Button variant="ghost" onClick={logout}><LogOut className="size-4" aria-hidden />{t("nav.logout")}</Button>
      </header>

      {!card ? <EmptyState icon={<CreditCard className="size-6" aria-hidden />} title={td("none")} description={td("noneDesc")} /> : (
        <>
          <div className="mb-5 flex gap-1 border-b border-line">
            {(["card", "activity"] as const).map((x) => <button key={x} type="button" onClick={() => setTab(x)} aria-current={tab === x ? "page" : undefined} className={cn("-mb-px border-b-2 px-4 py-2.5 text-sm transition", tab === x ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>{t(`nav.${x}`)}</button>)}
          </div>

          {tab === "card" ? (
            <div className="space-y-5">
              <CardFace card={card} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-card border border-line bg-surface p-4"><p className="text-xs text-muted">{td("cardholder")}</p><p className="font-medium">{card.cardholderName}</p></div>
                <div className="rounded-card border border-line bg-surface p-4"><p className="text-xs text-muted">{td("status")}</p><p className={cn("font-medium", card.status === "inactive" && "text-fin-warn", card.status === "canceled" && "text-fin-neg")}>{td(card.status === "inactive" ? "frozen" : card.status === "canceled" ? "canceled" : "active")}</p></div>
              </div>
              <div className="rounded-card border border-line bg-surface p-4">
                <div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium">{td("limits")}</p><Button size="sm" variant="ghost" onClick={() => setLimitOpen(true)}><Plus className="size-4" aria-hidden />{td("requestLimit")}</Button></div>
                {card.spendingLimits.length ? <ul className="space-y-1 text-sm">{card.spendingLimits.map((l, i) => <li key={i} className="flex justify-between"><span className="text-muted">{td("per", { interval: ti(l.interval as (typeof INTERVALS)[number]) })}</span><span className="num font-medium">{formatMoney(l.amount, card.currency)}</span></li>)}</ul> : <p className="text-sm text-muted">{td("noLimits")}</p>}
              </div>
              {card.frozen && <Callout tone="warn">{td("frozenNote")}</Callout>}
              {card.canFreeze && card.status !== "canceled" && (
                <Button variant={card.frozen ? "primary" : "secondary"} onClick={() => setFreezeTo(!card.frozen)}>{card.frozen ? <LockOpen className="size-4" aria-hidden /> : <Snowflake className="size-4" aria-hidden />}{card.frozen ? td("unfreeze") : td("freeze")}</Button>
              )}
            </div>
          ) : (
            <ActivityList activity={activity} currency={card.currency} onNote={setNoteFor} />
          )}
        </>
      )}

      <ConfirmDialog open={freezeTo !== null} onClose={() => setFreezeTo(null)} onConfirm={doFreeze} title={freezeTo ? td("freeze") : td("unfreeze")} description={freezeTo ? td("freezeConfirm") : td("unfreezeConfirm")} confirmLabel={freezeTo ? td("freeze") : td("unfreeze")} danger={!!freezeTo} />
      {limitOpen && card && <LimitDialog card={card} post={post} onClose={() => setLimitOpen(false)} />}
      {noteFor && card && <NoteDialog item={noteFor} card={card} post={post} onClose={() => setNoteFor(null)} onSaved={() => { setNoteFor(null); void loadActivity(); }} />}
    </div>
  );
}

function CardFace({ card }: { card: Card }) {
  return (
    <div className={cn("relative aspect-[1.586/1] max-w-sm overflow-hidden rounded-2xl bg-[var(--color-12)] p-5 text-[var(--color-1)] shadow-card", card.frozen && "opacity-80")}>
      <div aria-hidden className="absolute -end-10 -top-10 size-40 rounded-full bg-[var(--color-5)] opacity-20 blur-2xl" />
      <div className="flex items-start justify-between"><span className="text-sm font-medium">{card.nickname ?? card.cardholderName}</span><CreditCard className="size-6 opacity-70" aria-hidden /></div>
      <div className="mt-8 font-mono text-xl tracking-[0.2em]">•••• •••• •••• {card.last4 ?? "••••"}</div>
      <div className="mt-4 flex items-end justify-between text-xs text-[var(--color-2)]">
        <span>{card.expMonth && card.expYear ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}` : ""}</span>
        <span className="uppercase">{card.brand ?? ""} · {card.currency.toUpperCase()}</span>
      </div>
      {card.frozen && <div className="absolute inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--color-3)_35%,transparent)]"><Snowflake className="size-10" aria-hidden /></div>}
    </div>
  );
}

function ActivityList({ activity, currency, onNote }: { activity: Activity[] | null; currency: string; onNote: (a: Activity) => void }) {
  const td = useTranslations("treasury.staff.activity");
  const locale = useLocale();
  if (activity === null) return <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (!activity.length) return <p className="py-10 text-center text-sm text-muted">{td("none")}</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
      {activity.map((a) => (
        <li key={`${a.kind}-${a.id}`} className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{a.merchant ?? (a.kind === "transaction" ? td("posted") : "—")}</p>
            <p className="text-xs text-muted">{new Date(a.createdAt * 1000).toLocaleString(locale)}{a.category ? ` · ${a.category}` : ""}</p>
            {a.note && <p className="mt-1 truncate text-xs text-muted">“{a.note}”</p>}
          </div>
          <div className="text-end">
            <p className={cn("num font-semibold tabular-nums", a.declined && "text-muted line-through")}>{formatMoney(a.amount, a.currency || currency)}</p>
            <span className={cn("text-[11px]", a.declined ? "text-fin-neg" : a.status === "pending" ? "text-fin-warn" : "text-muted")}>{a.declined ? td("declined") : a.kind === "transaction" ? td(a.status === "refund" ? "refund" : "posted") : td(a.status === "pending" ? "pending" : a.status === "reversed" ? "reversed" : "approved")}</span>
          </div>
          <button type="button" onClick={() => onNote(a)} title={a.hasReceipt ? td("viewReceipt") : td("addNote")} className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted hover:text-fg">{a.hasReceipt ? <Receipt className="size-4" aria-hidden /> : <Paperclip className="size-4" aria-hidden />}</button>
        </li>
      ))}
    </ul>
  );
}

function LimitDialog({ card, post, onClose }: { card: Card; post: (u: string, b?: unknown) => Promise<unknown>; onClose: () => void }) {
  const td = useTranslations("treasury.staff.limitReq");
  const ti = useTranslations("treasury.intervals");
  const tc = useTranslations("treasury.common");
  const toast = useToast();
  const [interval, setInterval] = useState("monthly"); const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const current = card.spendingLimits.find((l) => l.interval === interval)?.amount ?? null;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await post("/api/staff/treasury/limit-requests", { cardId: card.id, interval, amount: parseMajor(amount, card.currency), reason: reason || null }); toast("ok", td("sent")); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={td("title")} footer={<><Button onClick={onClose}>{tc("cancel")}</Button><Button variant="primary" loading={busy} disabled={!amount} onClick={save}>{td("submit")}</Button></>}>
      <div className="space-y-4">
        <Field label={td("interval")}>{(p) => <Select {...p} value={interval} onChange={(e) => setInterval(e.target.value)}>{INTERVALS.map((i) => <option key={i} value={i}>{ti(i)}</option>)}</Select>}</Field>
        <Field label={td("amount")} hint={current !== null ? td("current", { v: `${toDecimalString(current, card.currency)} ${card.currency.toUpperCase()}` }) : undefined}>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label={td("reason")}>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-20" />}</Field>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

function NoteDialog({ item, card, post, onClose, onSaved }: { item: Activity; card: Card; post: (u: string, b?: unknown, f?: FormData) => Promise<unknown>; onClose: () => void; onSaved: () => void }) {
  const td = useTranslations("treasury.staff.activity");
  const tc = useTranslations("treasury.common");
  const toast = useToast();
  const [note, setNote] = useState(item.note ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveNote = async () => {
    setBusy(true); setErr(null);
    try { await post("/api/staff/treasury/expenses", { cardId: card.id, stripeObjectId: item.id, note: note || null }); toast("ok", td("noteSaved")); onSaved(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const upload = async (file: File) => {
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set("file", file); fd.set("cardId", card.id); fd.set("stripeObjectId", item.id);
    try { await post("/api/staff/treasury/expenses/receipt", undefined, fd); toast("ok", td("receiptSaved")); onSaved(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={item.merchant ?? td("note")} footer={<><Button onClick={onClose}>{tc("cancel")}</Button><Button variant="primary" loading={busy} onClick={saveNote}>{td("saveNote")}</Button></>}>
      <div className="space-y-4">
        <Field label={td("note")}>{(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} placeholder={td("notePlaceholder")} className="min-h-24" />}</Field>
        <div>
          <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Paperclip className="size-4" aria-hidden />}{item.hasReceipt ? td("receipt") : td("addReceipt")}</Button>
          {item.hasReceipt && <a href={`/api/staff/treasury/receipts/${item.id}`} target="_blank" rel="noreferrer" className="ms-3 text-sm font-medium text-fg underline underline-offset-4">{td("viewReceipt")}</a>}
        </div>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}
