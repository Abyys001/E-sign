"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, Copy, FlaskConical, Radio, RotateCcw, ShieldAlert, Undo2, type LucideIcon } from "lucide-react";
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
const NAV = [
  { href: "/accounting", key: "dashboard", exact: true },
  { href: "/accounting/overview", key: "overview" },
  { href: "/accounting/events", key: "events" },
  { href: "/accounting/transactions", key: "transactions" },
  { href: "/accounting/organisers", key: "organisers" },
  { href: "/accounting/payments", key: "payments" },
  { href: "/accounting/refunds", key: "refunds" },
  { href: "/accounting/books", key: "books" },
  { href: "/accounting/stripe", key: "stripe" },
  { href: "/accounting/wise", key: "wise" },
  { href: "/accounting/reconciliation", key: "reconciliation" },
  { href: "/accounting/reports", key: "reports" },
  { href: "/accounting/ai", key: "ai" },
  { href: "/accounting/ledger", key: "ledger" },
  { href: "/accounting/settings", key: "settings", perm: "accounting.admin" },
] as const;

export function FinanceNav() {
  const t = useTranslations("accounting.nav");
  const path = usePathname();
  const { can } = useMe();
  return (
    <nav aria-label={t("label")} className="scroll-thin mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {NAV.filter((x) => !("perm" in x) || can(x.perm)).map((x) => {
        const active = "exact" in x ? path === x.href : path === x.href || path.startsWith(`${x.href}/`);
        return <Link key={x.href} href={x.href} aria-current={active ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm transition", active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>{t(x.key)}</Link>;
      })}
    </nav>
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

export function AmountCard({ label, v, c, tone, icon: Icon, hint }: { label: string; v: number; c: string; tone: Tone; icon: LucideIcon; hint?: React.ReactNode }) {
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
