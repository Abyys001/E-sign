"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, ArrowLeftRight, Banknote, Bell, Search, Wallet, BookOpen, Bot, CalendarDays, CheckCircle2, CircleDashed, CircleHelp, Copy, CreditCard, FileBarChart, FlaskConical, HandCoins, LayoutDashboard, Landmark, Library, Radio, RotateCcw, Scale, Send, Settings, ShieldAlert, Sparkles, TrendingUp, Undo2, Users, type LucideIcon } from "lucide-react";
import { useMe } from "@/components/app/me";
import { cn } from "@/components/ui/cn";
import { Input, Select } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/feedback";
import { api, useApi } from "@/lib/api";
import { formatMoney } from "@/lib/money";

// ---------- Stripe mode (test / live): every finance request carries it, and the screen always says which one is shown ----------
type Mode = "test" | "live";
const ModeCtx = createContext<{ mode: Mode; setMode: (m: Mode) => void; q: (path: string) => string }>({ mode: "test", setMode: () => {}, q: (p) => p });
export const useMode = () => useContext(ModeCtx);
const KEY = "bilit.finance.mode";

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const { data } = useApi<{ defaultMode: Mode }>("/api/accounting/settings");
  const [mode, setModeState] = useState<Mode | null>(null);
  useEffect(() => {
    if (mode || !data) return;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(KEY); } catch { /* storage may be unavailable */ }
    setModeState(saved === "test" || saved === "live" ? saved : data.defaultMode);
  }, [data, mode]);
  const setMode = useCallback((m: Mode) => { setModeState(m); try { sessionStorage.setItem(KEY, m); } catch { /* ignore */ } }, []);
  const value = useMemo(() => ({ mode: mode ?? "test", setMode, q: (p: string) => `${p}${p.includes("?") ? "&" : "?"}mode=${mode ?? "test"}` }), [mode, setMode]);
  if (!mode) return null;
  return <ModeCtx.Provider value={value}>{children}</ModeCtx.Provider>;
}

export function ModeSwitch() {
  const t = useTranslations("accounting.mode");
  const { mode, setMode } = useMode();
  return (
    <div role="radiogroup" aria-label={t("label")} className="inline-flex rounded-xl border border-line-strong bg-surface p-0.5 text-xs font-semibold">
      {(["test", "live"] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
          className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 uppercase tracking-wide transition", mode === m ? (m === "live" ? "bg-accent text-accent-fg" : "bg-fg text-bg") : "text-muted hover:text-fg")}>
          {m === "live" ? <Radio className="size-3.5" aria-hidden /> : <FlaskConical className="size-3.5" aria-hidden />}{t(m)}
        </button>
      ))}
    </div>
  );
}

export function ModeBanner() {
  const t = useTranslations("accounting.mode");
  const { mode } = useMode();
  if (mode === "live") return null;
  return <div role="status" className="mb-4 flex items-center gap-2 rounded-xl border-2 border-dashed border-fg px-3.5 py-2 text-sm font-medium"><FlaskConical className="size-4" aria-hidden />{t("testBanner")}</div>;
}

// ---------- navigation ----------
type NavItem = { href: string; key: string; icon: LucideIcon; exact?: true; perm?: "accounting.admin" | "accounting.manage" };
/** Finance sections grouped the way accountants look for them. Routes are unchanged; only presentation is grouped. */
const NAV_GROUPS: ReadonlyArray<{ key: string; items: ReadonlyArray<NavItem> }> = [
  { key: "overview", items: [
    { href: "/accounting", key: "dashboard", icon: LayoutDashboard, exact: true },
    { href: "/accounting/position", key: "position", icon: Scale },
    { href: "/accounting/overview", key: "overview", icon: TrendingUp },
    { href: "/accounting/reports", key: "reports", icon: FileBarChart },
    { href: "/accounting/ai", key: "ai", icon: Bot },
  ] },
  { key: "transactions", items: [
    { href: "/accounting/transactions", key: "transactions", icon: ArrowLeftRight },
    { href: "/accounting/refunds", key: "refunds", icon: Undo2 },
    { href: "/accounting/reconciliation", key: "reconciliation", icon: CheckCircle2 },
  ] },
  { key: "events", items: [{ href: "/accounting/events", key: "events", icon: CalendarDays }] },
  { key: "organisers", items: [
    { href: "/accounting/organisers", key: "organisers", icon: Users },
    { href: "/accounting/payments", key: "payments", icon: Banknote },
    { href: "/accounting/payouts", key: "payouts", icon: Send },
  ] },
  { key: "accounting", items: [
    { href: "/accounting/books", key: "books", icon: BookOpen },
    { href: "/accounting/profit-share", key: "profitShare", icon: HandCoins },
    { href: "/accounting/ledger", key: "ledger", icon: Library },
  ] },
  { key: "integrations", items: [
    { href: "/accounting/stripe", key: "stripe", icon: CreditCard },
    { href: "/accounting/wise", key: "wise", icon: Landmark },
    { href: "/accounting/settings", key: "settings", icon: Settings, perm: "accounting.admin" },
  ] },
];
const NAV: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((g) => g.items);
const isActive = (x: NavItem, path: string) => (x.exact ? path === x.href : path === x.href || path.startsWith(`${x.href}/`));

/** Compact tab bar (below xl, where the finance sidebar is hidden): every section, with icons, scrolls horizontally. */
export function FinanceNav() {
  const t = useTranslations("accounting.nav");
  const path = usePathname();
  const { can } = useMe();
  return (
    <nav aria-label={t("label")} className="scroll-thin mb-5 flex gap-1 overflow-x-auto border-b border-line xl:hidden">
      {NAV.filter((x) => !x.perm || can(x.perm)).map((x) => {
        const active = isActive(x, path);
        return <Link key={x.href} href={x.href} aria-current={active ? "page" : undefined} className={cn("-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition", active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}><x.icon className="size-4 shrink-0" aria-hidden />{t(x.key as never)}</Link>;
      })}
    </nav>
  );
}

/** Grouped finance sidebar (xl and up). Only sections the user may open are listed. */
export function FinanceSidebar() {
  const t = useTranslations("accounting.nav");
  const path = usePathname();
  const { can } = useMe();
  return (
    <nav aria-label={t("label")} className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] w-52 shrink-0 overflow-y-auto pe-2 scroll-thin xl:block">
      {NAV_GROUPS.map((g) => {
        const items = g.items.filter((x) => !x.perm || can(x.perm));
        if (!items.length) return null;
        return (
          <div key={g.key} className="mb-5">
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t(`groups.${g.key}` as never)}</p>
            <ul className="space-y-0.5">{items.map((x) => {
              const active = isActive(x, path);
              return <li key={x.href}><Link href={x.href} aria-current={active ? "page" : undefined} className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active ? "bg-surface font-medium text-fg shadow-card ring-1 ring-line" : "text-muted hover:bg-surface hover:text-fg")}>
                <x.icon className={cn("size-4 shrink-0", active && "text-accent")} aria-hidden />{t(x.key as never)}</Link></li>;
            })}</ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Every finance section as an icon button — shown on the dashboard on smaller screens (the sidebar covers wide screens). */
export function FinanceShortcuts() {
  const t = useTranslations("accounting.nav");
  const { can } = useMe();
  return (
    <nav aria-label={t("label")} className="mb-6 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 xl:hidden">
      {NAV.filter((x) => !x.exact && (!x.perm || can(x.perm))).map((x) => (
        <Link key={x.href} href={x.href} className="group flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface p-3 text-center text-xs font-medium transition hover:border-accent">
          <span className="grid size-9 place-items-center rounded-lg bg-accent-soft transition group-hover:scale-105"><x.icon className="size-[18px]" aria-hidden /></span>
          {t(x.key as never)}
        </Link>
      ))}
    </nav>
  );
}

type Status = { stripe: { connected: boolean; status: string; displayName: string | null; lastSyncAt: string | null; lastWebhookAt: string | null; lastError: string | null; lastRun: { status: string; error: string | null; finishedAt: string | null; imported: number; errors: number } | null; transactions: number; openSyncErrors: number }; review: { unmatched: number; needsReview: number; unlinkedRefunds: number; organisersOwed: number; pendingOrganiserPayments: number; payoutsFailed: number; payoutsUnconfirmed: number } };
/** Shared, cached-per-mode fetch of the dashboard status (Stripe + review counts). */
export function useFinanceStatus() {
  const { q } = useMode();
  return useApi<Status>(q("/api/accounting/dashboard/status"));
}

/** Finance header: brand, finance search (transactions), alerts and Stripe status, TEST/LIVE switch. */
export function FinanceHeader() {
  const t = useTranslations("accounting.shell");
  const router = useRouter();
  const [text, setText] = useState("");
  const { data } = useFinanceStatus();
  const alerts = data ? data.review.unmatched + data.review.needsReview + data.review.unlinkedRefunds + data.review.payoutsFailed + data.review.payoutsUnconfirmed + (data.stripe.lastError || data.stripe.openSyncErrors || data.stripe.lastRun?.status === "FAILED" ? 1 : 0) : 0;
  const stripeOk = data?.stripe.connected && !data.stripe.lastError && data.stripe.lastRun?.status !== "FAILED";
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <Link href="/accounting" className="flex items-center gap-2.5 me-auto">
        <span className="grid size-9 place-items-center rounded-xl bg-fg text-bg"><Wallet className="size-[18px]" aria-hidden /></span>
        <span className="leading-tight"><span className="block text-[15px] font-semibold tracking-tight">{t("brand")}</span><span className="block text-xs text-muted">{t("tagline")}</span></span>
      </Link>
      <form role="search" onSubmit={(e) => { e.preventDefault(); if (text.trim()) router.push(`/accounting/transactions?q=${encodeURIComponent(text.trim())}`); }} className="relative order-last w-full sm:order-none sm:w-64">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={text} onChange={(e) => setText(e.target.value)} aria-label={t("search")} placeholder={t("search")} className="h-9 ps-9 text-sm" />
      </form>
      <Link href="/accounting/stripe" title={data ? (stripeOk ? t("stripeOk") : t("stripeIssue")) : undefined} className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-xs font-medium hover:border-line-strong">
        <span aria-hidden className={cn("size-2 rounded-full", !data ? "bg-line-strong" : stripeOk ? "bg-fin-pos" : "bg-fin-neg")} />Stripe<span className="sr-only">{data ? (stripeOk ? t("stripeOk") : t("stripeIssue")) : ""}</span>
      </Link>
      <Link href="/accounting#alerts" aria-label={t("alerts", { n: alerts })} title={t("alerts", { n: alerts })} className="relative grid size-9 place-items-center rounded-xl border border-line bg-surface hover:border-line-strong">
        <Bell className="size-4" aria-hidden />
        {alerts > 0 && <span className="num absolute -end-1.5 -top-1.5 min-w-5 rounded-full bg-fg px-1 text-center text-[11px] font-semibold leading-5 text-bg">{alerts > 99 ? "99+" : alerts}</span>}
      </Link>
      <ModeSwitch />
    </div>
  );
}

export function SubNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const path = usePathname();
  return (
    <div className="mb-5 flex flex-wrap gap-1.5">
      {items.map((i) => <Link key={i.href} href={i.href} aria-current={path === i.href ? "page" : undefined} className={cn("rounded-full border px-3 py-1 text-sm transition", path === i.href ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg")}>{i.label}</Link>)}
    </div>
  );
}

export function FinanceGate({ children }: { children: React.ReactNode }) {
  const t = useTranslations("accounting");
  const { me, can } = useMe();
  if (!me.features?.accounting) return <EmptyState title={t("disabled.title")} description={t("disabled.desc")} />;
  if (!can("accounting.view")) return <EmptyState icon={<ShieldAlert className="size-6" aria-hidden />} title={t("forbidden.title")} description={t("forbidden.desc")} />;
  return <ModeProvider>{children}</ModeProvider>;
}

// ---------- money ----------
/** Minor units → localized currency. Negative values keep their sign (no colour-only meaning). */
export function Money({ v, c, className, strong }: { v: number | null | undefined; c: string; className?: string; strong?: boolean }) {
  const locale = useLocale();
  return <span className={cn("num whitespace-nowrap tabular-nums", strong && "font-semibold", className)}>{formatMoney(v, c, locale)}</span>;
}
// ---------- Colour-coded amount cards: the whole card is tinted by what the amount means ----------
export type Tone = "pos" | "neg" | "warn" | "info" | "bal";
// Literal class strings so Tailwind picks them up.
const TONES: Record<Tone, { card: string; text: string; chip: string; bar: string }> = {
  pos: { card: "border-fin-pos/30 bg-fin-pos/10", text: "text-fin-pos", chip: "bg-fin-pos/20 text-fin-pos", bar: "bg-fin-pos" },
  neg: { card: "border-fin-neg/30 bg-fin-neg/10", text: "text-fin-neg", chip: "bg-fin-neg/20 text-fin-neg", bar: "bg-fin-neg" },
  warn: { card: "border-fin-warn/30 bg-fin-warn/10", text: "text-fin-warn", chip: "bg-fin-warn/20 text-fin-warn", bar: "bg-fin-warn" },
  info: { card: "border-fin-info/30 bg-fin-info/10", text: "text-fin-info", chip: "bg-fin-info/20 text-fin-info", bar: "bg-fin-info" },
  bal: { card: "border-fin-bal/30 bg-fin-bal/10", text: "text-fin-bal", chip: "bg-fin-bal/20 text-fin-bal", bar: "bg-fin-bal" },
};

export function AmountCard({ label, v, c, tone, icon: Icon, hint, onAsk, askLabel }: { label: string; v: number; c: string; tone: Tone; icon: LucideIcon; hint?: React.ReactNode; onAsk?: () => void; askLabel?: string }) {
  // A negative amount always reads as a loss, whatever the card's usual tone.
  const k = TONES[v < 0 ? "neg" : tone];
  return (
    <div className={cn("rise relative overflow-hidden rounded-card border p-5 shadow-card", k.card)}>
      <span aria-hidden className={cn("absolute inset-y-0 start-0 w-1", k.bar)} />
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-fg/80">
        <span>{label}</span>
        <span className={cn("grid size-8 place-items-center rounded-lg", k.chip)}><Icon className="size-4" aria-hidden /></span>
      </div>
      <div className={cn("num mt-2 text-3xl font-semibold tracking-tight", k.text)}><Money v={v} c={c} /></div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
      {onAsk && <button type="button" onClick={onAsk} aria-label={askLabel} title={askLabel} className="absolute bottom-2 end-2 grid size-7 place-items-center rounded-lg text-muted opacity-70 hover:bg-accent-soft hover:text-accent hover:opacity-100 focus-visible:opacity-100"><Sparkles className="size-3.5" aria-hidden /></button>}
    </div>
  );
}

export const useMoney = () => { const locale = useLocale(); return (v: number | null | undefined, c: string) => formatMoney(v, c, locale); };

// ---------- date ranges ----------
export type RangeKey = "today" | "yesterday" | "week" | "month" | "lastMonth" | "year" | "all" | "custom";
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function rangeFor(k: RangeKey, custom?: { from?: string; to?: string }): { from?: string; to?: string } {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (k) {
    case "today": return { from: iso(now), to: iso(now) };
    case "yesterday": { const p = new Date(y, m, d - 1); return { from: iso(p), to: iso(p) }; }
    case "week": { const dow = (now.getDay() + 6) % 7; return { from: iso(new Date(y, m, d - dow)), to: iso(now) }; }
    case "month": return { from: iso(new Date(y, m, 1)), to: iso(now) };
    case "lastMonth": return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "year": return { from: iso(new Date(y, 0, 1)), to: iso(now) };
    case "custom": return { from: custom?.from || undefined, to: custom?.to || undefined };
    default: return {};
  }
}
export const rangeQuery = (r: { from?: string; to?: string }) => `${r.from ? `&from=${r.from}` : ""}${r.to ? `&to=${r.to}` : ""}`;

export function RangePicker({ value, onChange, keys = ["today", "yesterday", "week", "month", "lastMonth", "year", "all", "custom"] }: { value: { key: RangeKey; from?: string; to?: string }; onChange: (v: { key: RangeKey; from?: string; to?: string }) => void; keys?: RangeKey[] }) {
  const t = useTranslations("accounting.range");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label={t("label")} value={value.key} onChange={(e) => onChange({ key: e.target.value as RangeKey, from: value.from, to: value.to })} className="w-auto min-w-40">
        {keys.map((k) => <option key={k} value={k}>{t(k)}</option>)}
      </Select>
      {value.key === "custom" && <>
        <Input type="date" aria-label={t("from")} value={value.from ?? ""} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-auto" />
        <Input type="date" aria-label={t("to")} value={value.to ?? ""} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-auto" />
      </>}
    </div>
  );
}

// ---------- statuses ----------
const TONE: Record<string, "done" | "active" | "idle" | "stopped"> = {
  MATCHED: "done", REFUND: "done", DISPUTE: "active", UNMATCHED: "stopped", PARTIAL: "active", DUPLICATE: "stopped", MANUAL_REVIEW: "stopped", ERROR: "stopped",
  NOT_APPLICABLE: "idle", POSTED: "done", REVERSED: "idle", PAID: "done", PENDING: "active", VOIDED: "idle", OPEN: "active", CLOSED: "done",
  SUCCEEDED: "done", RUNNING: "active", QUEUED: "idle", FAILED: "stopped", PROCESSED: "done", RECEIVED: "idle", IGNORED: "idle",
  CONNECTED: "done", DISCONNECTED: "idle", ACTIVE: "done", INACTIVE: "idle", CANCELLED: "stopped", ARCHIVED: "idle", WON: "done", LOST: "stopped",
  paid: "done", pending: "active", in_transit: "active", canceled: "idle", failed: "stopped",
  SENDING: "active", PROCESSING: "active", RETURNED: "stopped", CANCELED: "idle", REJECTED: "stopped",
};
const ICON = { done: CheckCircle2, active: CircleDashed, idle: CircleHelp, stopped: AlertTriangle };
const toneCls = { done: "border-accent bg-accent-soft", active: "border-line-strong bg-surface-2", idle: "border-dashed border-line-strong text-muted", stopped: "border-2 border-fg bg-surface font-medium" };

export function Badge({ s, className }: { s: string | null | undefined; className?: string }) {
  const t = useTranslations("accounting.status");
  if (!s) return <span className="text-muted">—</span>;
  const tone = TONE[s] ?? "idle";
  const Icon = s === "REVERSED" ? Undo2 : s === "VOIDED" ? RotateCcw : ICON[tone];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs", toneCls[tone], className)}><Icon className="size-3.5" aria-hidden />{t.has(s as never) ? t(s as never) : s}</span>;
}

export function Reason({ r }: { r: string | null | undefined }) {
  const t = useTranslations("accounting.reason");
  if (!r) return null;
  const key = r.startsWith("OVERRIDE_") ? "OVERRIDE" : r;
  return <span className="text-xs text-muted">{t.has(key as never) ? t(key as never) : r}</span>;
}

export function CopyText({ text, className }: { text: string; className?: string }) {
  const t = useTranslations("common");
  const [ok, setOk] = useState(false);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <code className="truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs">{text}</code>
      <button type="button" aria-label={t("copy")} title={ok ? t("copied") : t("copy")} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }); }} className="grid size-7 shrink-0 place-items-center rounded-lg hover:bg-surface-2"><Copy className="size-3.5" aria-hidden /></button>
    </span>
  );
}

export function DL({ items }: { items: Array<[string, React.ReactNode]> }) {
  return <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">{items.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{v ?? "—"}</dd></div>)}</dl>;
}

/** Lightweight option lists for pickers (events / organisers / accounts). */
export function useOptions<T>(path: string | null) { const { data } = useApi<{ items: T[] }>(path); return data?.items ?? []; }
export const exportUrl = (path: string) => `${path}${path.includes("?") ? "&" : "?"}format=csv`;

/** Download a CSV export after the elevation check (exports contain customer data). */
export function useExport() {
  return async (ensure: () => Promise<boolean>, url: string) => { if (await ensure()) window.location.href = exportUrl(url); };
}
export { api };
