"use client";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle2, CircleAlert, CreditCard, Info, RefreshCw, type LucideIcon } from "lucide-react";
import { Badge, Money, useFinanceStatus, useMode } from "@/components/accounting/kit";
import { cn } from "@/components/ui/cn";
import { Skeleton } from "@/components/ui/feedback";
import { fmtDate, useApi } from "@/lib/api";
import { formatMoney } from "@/lib/money";

/** Presentation only: every figure below is passed in from the existing finance APIs. */

// ---------- KPI card ----------
export function Kpi({ label, def, v, prev, c, icon: Icon, tone = "neutral", lowerIsBetter, href, sub }: {
  label: string; def: string; v: number; prev?: number | null; c: string; icon: LucideIcon; tone?: "neutral" | "pos" | "neg" | "warn" | "info"; lowerIsBetter?: boolean; href?: string; sub?: React.ReactNode;
}) {
  const t = useTranslations("accounting.cc");
  const id = useId();
  const delta = prev !== undefined && prev !== null && prev !== 0 ? ((v - prev) / Math.abs(prev)) * 100 : null;
  const good = delta === null ? null : lowerIsBetter ? delta <= 0 : delta >= 0;
  const chip = { neutral: "bg-surface-2 text-fg", pos: "bg-fin-pos/12 text-fin-pos", neg: "bg-fin-neg/12 text-fin-neg", warn: "bg-fin-warn/12 text-fin-warn", info: "bg-fin-info/12 text-fin-info" }[tone];
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] font-medium text-muted" id={id}>{label}</span>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", chip)}><Icon className="size-4" aria-hidden /></span>
      </div>
      <div className={cn("num mt-1.5 text-[26px] font-semibold leading-tight tracking-tight", v < 0 && "text-fin-neg")} aria-describedby={`${id}-d`}><Money v={v} c={c} /></div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {delta !== null ? (
          <span className={cn("inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium", good ? "bg-fin-pos/12 text-fin-pos" : "bg-fin-neg/12 text-fin-neg")} title={t("vsPrev", { v: formatMoney(prev!, c) })}>
            {delta >= 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}{Math.abs(delta) >= 1000 ? ">999" : Math.abs(delta).toFixed(1)}%
            <span className="sr-only">{t("vsPrev", { v: formatMoney(prev!, c) })}</span>
          </span>
        ) : prev === 0 && v !== 0 ? <span className="text-muted">{t("newVsPrev")}</span> : null}
        {sub && <span className="text-muted">{sub}</span>}
      </div>
      <p id={`${id}-d`} className="mt-2 border-t border-line pt-2 text-[11.5px] leading-snug text-muted">{def}</p>
    </>
  );
  const cls = "rise block rounded-card border border-line bg-surface p-4 shadow-card transition";
  return href ? <Link href={href} className={cn(cls, "hover:border-line-strong hover:-translate-y-px")}>{body}</Link> : <div className={cls}>{body}</div>;
}

// ---------- revenue chart ----------
export type SeriesPoint = { period: string; grossSales: number; refunds: number; chargebacks: number; stripeFees: number; net: number };
const SERIES = [
  { key: "grossSales", color: "var(--accent)", dash: undefined, width: 2.5 },
  { key: "net", color: "var(--fg)", dash: undefined, width: 2 },
  { key: "refunds", color: "var(--fin-neg)", dash: "5 4", width: 1.75 },
  { key: "stripeFees", color: "var(--fin-warn)", dash: "2 3", width: 1.75 },
] as const;
type SKey = (typeof SERIES)[number]["key"];
const val = (p: SeriesPoint, k: SKey) => (k === "refunds" ? p.refunds + p.chargebacks : p[k]);

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export function RevenueChart({ points, currency, grain }: { points: SeriesPoint[]; currency: string; grain: string }) {
  const t = useTranslations("accounting.cc");
  const locale = useLocale();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<SKey>>(new Set());
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const H = 260, padL = 64, padR = 12, padT = 12, padB = 28;
  const visible = SERIES.filter((s) => !hidden.has(s.key));
  const max = niceMax(Math.max(0, ...points.flatMap((p) => visible.map((s) => val(p, s.key)))));
  const min = Math.min(0, ...points.map((p) => (hidden.has("net") ? 0 : p.net)));
  const span = max - min || 1;
  const iw = w - padL - padR, ih = H - padT - padB;
  const x = (i: number) => padL + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => padT + ih - ((v - min) / span) * ih;
  const label = (p: string) => { const d = new Date(`${p}T00:00:00Z`); return grain === "year" ? p.slice(0, 4) : grain === "month" ? d.toLocaleDateString(locale, { month: "short", year: "2-digit", timeZone: "UTC" }) : d.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" }); };
  const compact = (v: number) => new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), notation: "compact", maximumFractionDigits: 1 }).format(v / 100);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * span);
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 72))));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * w;
    const i = points.length <= 1 ? 0 : Math.round(((px - padL) / iw) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };
  const hp = hover !== null ? points[hover] : null;
  return (
    <figure ref={box} className="relative">
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t("series")}>
        {SERIES.map((s) => (
          <button key={s.key} type="button" aria-pressed={!hidden.has(s.key)} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })}
            className={cn("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition", hidden.has(s.key) ? "border-line text-muted line-through" : "border-line-strong text-fg")}>
            <svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} /></svg>{t(`s.${s.key}`)}
          </button>
        ))}
      </div>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-labelledby={`${id}-t`} className="block max-w-full touch-none select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{t("chartTitle", { c: currency.toUpperCase() })}</title>
        <defs><linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {ticks.map((v, i) => <g key={i}><line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : "3 4"} /><text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{compact(v)}</text></g>)}
        {points.map((p, i) => ((i % every === 0 && points.length - 1 - i >= every / 2) || i === points.length - 1) && <text key={p.period} x={x(i)} y={H - 8} textAnchor={points.length > 1 && i === points.length - 1 ? "end" : i === 0 && points.length > 1 ? "start" : "middle"} fontSize="11" fill="var(--muted)">{label(p.period)}</text>)}
        {!hidden.has("grossSales") && points.length > 1 && <path d={`M${x(0)},${y(Math.max(min, 0))} ${points.map((p, i) => `L${x(i)},${y(p.grossSales)}`).join(" ")} L${x(points.length - 1)},${y(Math.max(min, 0))} Z`} fill={`url(#${id}-g)`} />}
        {visible.map((s) => <path key={s.key} d={points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(val(p, s.key))}`).join(" ")} fill="none" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />)}
        {points.length === 1 && visible.map((s) => <circle key={s.key} cx={x(0)} cy={y(val(points[0]!, s.key))} r="4" fill={s.color} />)}
        {hp && <g><line x1={x(hover!)} x2={x(hover!)} y1={padT} y2={padT + ih} stroke="var(--line-strong)" />{visible.map((s) => <circle key={s.key} cx={x(hover!)} cy={y(val(hp, s.key))} r="4" fill="var(--surface)" stroke={s.color} strokeWidth="2" />)}</g>}
      </svg>
      {hp && (
        <div role="status" className="pointer-events-none absolute top-12 z-10 min-w-48 rounded-xl border border-line bg-surface p-3 text-xs shadow-card" style={{ insetInlineStart: x(hover!) > w / 2 ? Math.max(0, x(hover!) - 212) : x(hover!) + 12 }}>
          <p className="mb-1.5 font-semibold">{label(hp.period)}{grain === "week" ? ` (${t("weekOf")})` : ""}</p>
          {SERIES.map((s) => <p key={s.key} className="flex items-center justify-between gap-4"><span className="flex items-center gap-1.5 text-muted"><i className="inline-block size-2 rounded-full" style={{ background: s.color }} />{t(`s.${s.key}`)}</span><Money v={val(hp, s.key)} c={currency} className="font-medium" /></p>)}
        </div>
      )}
      <table className="sr-only"><caption>{t("chartTitle", { c: currency.toUpperCase() })}</caption><thead><tr><th>{t("period")}</th>{SERIES.map((s) => <th key={s.key}>{t(`s.${s.key}`)}</th>)}</tr></thead>
        <tbody>{points.map((p) => <tr key={p.period}><td>{p.period}</td>{SERIES.map((s) => <td key={s.key}>{formatMoney(val(p, s.key), currency, locale)}</td>)}</tr>)}</tbody></table>
    </figure>
  );
}

/** Fill empty periods with zeros so the line shows quiet days/months instead of skipping them. */
export function fillSeries(items: SeriesPoint[], grain: "day" | "week" | "month" | "year", from?: string, to?: string): SeriesPoint[] {
  if (!items.length) return [];
  const step = (d: Date) => { const n = new Date(d); if (grain === "day") n.setUTCDate(n.getUTCDate() + 1); else if (grain === "week") n.setUTCDate(n.getUTCDate() + 7); else if (grain === "month") n.setUTCMonth(n.getUTCMonth() + 1); else n.setUTCFullYear(n.getUTCFullYear() + 1); return n; };
  const trunc = (s: string) => { const d = new Date(`${s}T00:00:00Z`); if (grain === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); if (grain === "month" || grain === "year") d.setUTCDate(1); if (grain === "year") d.setUTCMonth(0); return d; };
  const by = new Map(items.map((p) => [p.period, p]));
  const start = trunc(from && from < items[0]!.period ? from : items[0]!.period);
  const last = items[items.length - 1]!.period;
  const end = trunc(to && to > last ? to : last);
  const out: SeriesPoint[] = [];
  for (let d = start, i = 0; d <= end && i < 1000; d = step(d), i++) { const k = d.toISOString().slice(0, 10); out.push(by.get(k) ?? { period: k, grossSales: 0, refunds: 0, chargebacks: 0, stripeFees: 0, net: 0 }); }
  return out;
}

// ---------- revenue breakdown ----------
type Fig = { grossSales: number; refunds: number; chargebacks: number; stripeFees: number; stripeFeesRecharged: number; netStripeFees: number; organiserPayable: number; organiserPayments: number; organiserOutstanding: number; bilitRevenue: number; otherCosts: number; bilitProfit: number; commission: number; eventFees: number; otherRevenue: number };
function Row({ label, v, c, strong, minus, hint }: { label: string; v: number; c: string; strong?: boolean; minus?: boolean; hint?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5 text-sm", strong && "mt-1 border-t border-line pt-2.5 font-semibold")}>
      <span className={cn(!strong && "text-muted")}>{label}{hint && <span className="block text-[11px] font-normal leading-snug text-muted">{hint}</span>}</span>
      <Money v={minus ? -v : v} c={c} className={cn(minus && v ? "text-fin-neg" : "")} />
    </div>
  );
}
const Block = ({ title, children }: { title: string; children: React.ReactNode }) => <div><p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</p>{children}</div>;

/**
 * Three separate statements, each adding up exactly: what was collected, Bilit's own result (ledger P&L) and the organiser
 * account. They are deliberately not summed into one another, so no fee, refund or expense is ever counted twice.
 */
export function Breakdown({ f, c }: { f: Fig; c: string }) {
  const t = useTranslations("accounting.cc");
  const refunds = f.refunds + f.chargebacks;
  const net = f.grossSales - refunds - f.stripeFees;
  const otherBilitCosts = f.bilitRevenue - f.netStripeFees - f.bilitProfit; // everything else the P&L charged in the period
  const total = Math.max(1, f.grossSales);
  const seg = [{ k: "net", v: Math.max(0, net), cls: "bg-accent" }, { k: "refunds", v: refunds, cls: "bg-fin-neg" }, { k: "stripeFees", v: f.stripeFees, cls: "bg-fin-warn" }];
  return (
    <div className="space-y-6">
      <div>
        <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={t("bd.barLabel")}>
          {f.grossSales > 0 && seg.map((p) => p.v > 0 && <span key={p.k} className={p.cls} style={{ width: `${(p.v / total) * 100}%` }} title={`${t(`bd.seg.${p.k}`)}: ${formatMoney(p.v, c)}`} />)}
        </div>
        <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">{seg.map((p) => <li key={p.k} className="flex items-center gap-1.5"><i className={cn("inline-block size-2.5 rounded-sm", p.cls)} /><span className="text-muted">{t(`bd.seg.${p.k}`)}</span><span className="font-medium">{f.grossSales > 0 ? `${((p.v / total) * 100).toFixed(1)}%` : "—"}</span></li>)}</ul>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <Block title={t("bd.collected")}>
          <Row c={c} label={t("bd.gross")} v={f.grossSales} />
          <Row c={c} label={t("bd.refundsCb")} v={refunds} minus />
          <Row c={c} label={t("bd.stripeFeesGross")} v={f.stripeFees} minus />
          <Row c={c} label={t("bd.net")} v={net} strong hint={t("bd.netHint")} />
        </Block>
        <Block title={t("bd.bilitTitle")}>
          <Row c={c} label={t("bd.bilitRevenue")} v={f.bilitRevenue} hint={t("bd.bilitRevenueHint")} />
          <Row c={c} label={t("bd.feesBilit")} v={f.netStripeFees} minus hint={t("bd.feesBilitHint", { v: formatMoney(f.stripeFeesRecharged, c) })} />
          <Row c={c} label={t("bd.otherCosts")} v={otherBilitCosts} minus hint={t("bd.otherCostsHint")} />
          <Row c={c} label={t("bd.profit")} v={f.bilitProfit} strong hint={t("bd.profitHint")} />
        </Block>
        <Block title={t("bd.orgTitle")}>
          <Row c={c} label={t("bd.orgEarned")} v={f.organiserPayable} hint={t("bd.orgEarnedHint")} />
          <Row c={c} label={t("bd.orgPaid")} v={f.organiserPayments} minus />
          <div className="mt-1 border-t border-dashed border-line pt-1"><Row c={c} label={t("bd.orgOutstanding")} v={f.organiserOutstanding} hint={t("bd.orgOutstandingHint")} /></div>
        </Block>
      </div>
    </div>
  );
}

// ---------- alerts + Stripe status ----------
export function AlertsPanel() {
  const t = useTranslations("accounting.cc");
  const { data, error } = useFinanceStatus();
  if (error) return <p className="text-sm text-muted">{t("statusError")}</p>;
  if (!data) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11" />)}</div>;
  const r = data.review, s = data.stripe;
  const items: Array<{ id: string; tone: "crit" | "warn" | "info"; text: string; href: string }> = [];
  if (!s.connected) items.push({ id: "stripe", tone: "crit", text: t("al.notConnected"), href: "/accounting/stripe" });
  else if (s.lastRun?.status === "FAILED" || s.lastError) items.push({ id: "sync", tone: "crit", text: t("al.syncFailed"), href: "/accounting/stripe/sync" });
  if (s.openSyncErrors) items.push({ id: "syncErr", tone: "warn", text: t("al.syncErrors", { n: s.openSyncErrors }), href: "/accounting/stripe/sync" });
  if (r.unmatched) items.push({ id: "unmatched", tone: "warn", text: t("al.unmatched", { n: r.unmatched }), href: "/accounting/reconciliation" });
  if (r.needsReview) items.push({ id: "review", tone: "warn", text: t("al.review", { n: r.needsReview }), href: "/accounting/transactions?status=MANUAL_REVIEW" });
  if (r.unlinkedRefunds) items.push({ id: "refunds", tone: "warn", text: t("al.refunds", { n: r.unlinkedRefunds }), href: "/accounting/refunds" });
  if (r.payoutsFailed) items.push({ id: "payoutFailed", tone: "crit", text: t("al.payoutsFailed", { n: r.payoutsFailed }), href: "/accounting/payouts" });
  if (r.payoutsUnconfirmed) items.push({ id: "payoutSending", tone: "warn", text: t("al.payoutsUnconfirmed", { n: r.payoutsUnconfirmed }), href: "/accounting/payouts" });
  if (r.pendingOrganiserPayments) items.push({ id: "pending", tone: "info", text: t("al.pending", { n: r.pendingOrganiserPayments }), href: "/accounting/payments" });
  if (r.organisersOwed) items.push({ id: "owed", tone: "info", text: t("al.owed", { n: r.organisersOwed }), href: "/accounting/organisers" });
  if (!items.length) return <p className="flex items-center gap-2 rounded-xl bg-fin-pos/10 px-3 py-3 text-sm text-fin-pos"><CheckCircle2 className="size-4" aria-hidden />{t("al.none")}</p>;
  return (
    <ul className="space-y-1.5">{items.map((a) => (
      <li key={a.id}><Link href={a.href} className="group flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-sm transition hover:border-line-strong hover:bg-surface-2">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", a.tone === "crit" ? "bg-fin-neg/12 text-fin-neg" : a.tone === "warn" ? "bg-fin-warn/12 text-fin-warn" : "bg-fin-info/12 text-fin-info")}>
          {a.tone === "info" ? <Info className="size-4" aria-hidden /> : a.tone === "crit" ? <CircleAlert className="size-4" aria-hidden /> : <AlertTriangle className="size-4" aria-hidden />}</span>
        <span className="flex-1">{a.text}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5 rtl:rotate-180" aria-hidden />
      </Link></li>
    ))}</ul>
  );
}

export function StripeStatus() {
  const t = useTranslations("accounting.cc");
  const locale = useLocale();
  const { data } = useFinanceStatus();
  if (!data) return <Skeleton className="h-36" />;
  const s = data.stripe;
  const ok = s.connected && !s.lastError && s.lastRun?.status !== "FAILED";
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-surface-2"><CreditCard className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1"><p className="font-semibold">{s.displayName ?? "Stripe"}</p>
          <p className={cn("flex items-center gap-1.5 text-xs", ok ? "text-fin-pos" : "text-fin-neg")}><span className={cn("size-2 rounded-full", ok ? "bg-fin-pos" : "bg-fin-neg")} aria-hidden />{!s.connected ? t("st.disconnected") : ok ? t("st.connected") : t("st.problem")}</p></div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-muted">{t("st.lastSync")}</dt><dd className="font-medium">{s.lastSyncAt ? fmtDate(s.lastSyncAt, locale) : "—"}</dd></div>
        <div><dt className="text-xs text-muted">{t("st.lastRun")}</dt><dd>{s.lastRun ? <Badge s={s.lastRun.status} /> : "—"}</dd></div>
        <div><dt className="text-xs text-muted">{t("st.imported")}</dt><dd className="num font-medium">{s.transactions.toLocaleString(locale)}</dd></div>
        <div><dt className="text-xs text-muted">{t("st.webhook")}</dt><dd className="font-medium">{s.lastWebhookAt ? fmtDate(s.lastWebhookAt, locale) : t("st.noWebhook")}</dd></div>
      </dl>
      {(s.lastError || s.lastRun?.error) && <p className="mt-3 rounded-lg bg-fin-neg/10 px-3 py-2 text-xs text-fin-neg">{s.lastError ?? s.lastRun?.error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/accounting/stripe/sync" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-xs font-medium hover:bg-surface-2"><RefreshCw className="size-3.5" aria-hidden />{t("st.syncHistory")}</Link>
        <Link href="/accounting/stripe" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg">{t("st.settings")}</Link>
      </div>
    </div>
  );
}

// ---------- recent transactions ----------
type Tx = { id: string; balanceTransactionId: string; kind: string; amount: number; fee: number; net: number; currency: string; description: string | null; stripeCreatedAt: string; eventCode: string | null; eventId: string | null; eventName: string | null; organiserName: string | null; customerName: string | null; reconciliationStatus: string };
export function RecentTransactions({ currency }: { currency: string | null }) {
  const t = useTranslations("accounting.cc");
  const tk = useTranslations("accounting.kind");
  const locale = useLocale();
  const { q } = useMode();
  const { data } = useApi<{ items: Tx[] }>(q("/api/accounting/transactions?page=1&pageSize=25"));
  const rows = useMemo(() => (data?.items ?? []).filter((r) => !currency || r.currency === currency).slice(0, 8), [data, currency]);
  if (!data) return <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (!rows.length) return <p className="p-5 text-sm text-muted">{t("noTx")}</p>;
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full min-w-[720px] text-sm">
        <thead><tr className="border-b border-line text-start text-xs text-muted">{["date", "description", "event", "gross", "fee", "net", "status"].map((h) => <th key={h} scope="col" className={cn("px-4 py-2.5 font-medium", ["gross", "fee", "net"].includes(h) ? "text-end" : "text-start")}>{t(`tx.${h}`)}</th>)}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2">
            <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmtDate(r.stripeCreatedAt, locale)}</td>
            <td className="max-w-64 px-4 py-2.5"><Link href={`/accounting/transactions/${r.id}`} className="block truncate font-medium underline-offset-4 hover:underline">{r.customerName || r.description || r.balanceTransactionId}</Link><span className="block truncate text-xs text-muted">{tk(r.kind)}{r.organiserName ? ` · ${r.organiserName}` : ""}</span></td>
            <td className="px-4 py-2.5">{r.eventCode ? <code className="text-xs font-semibold">{r.eventCode}</code> : <span className="text-xs text-fin-warn">{t("tx.noCode")}</span>}{r.eventName && <span className="block max-w-40 truncate text-xs text-muted">{r.eventName}</span>}</td>
            <td className="px-4 py-2.5 text-end"><Money v={r.amount} c={r.currency} className={r.amount < 0 ? "text-fin-neg" : ""} /></td>
            <td className="px-4 py-2.5 text-end text-muted"><Money v={r.fee} c={r.currency} /></td>
            <td className="px-4 py-2.5 text-end"><Money v={r.net} c={r.currency} strong /></td>
            <td className="px-4 py-2.5"><Badge s={r.reconciliationStatus} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ---------- organiser liabilities ----------
export function OrganiserLiabilities({ currency }: { currency: string | null }) {
  const t = useTranslations("accounting.cc");
  const { q } = useMode();
  const { data } = useApi<{ outstanding: Array<{ organiserId: string; organiserName: string; currency: string; remaining: number }> }>(q("/api/accounting/finance/overview"));
  if (!data) return <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>;
  const rows = data.outstanding.filter((o) => (!currency || o.currency === currency) && o.remaining !== 0).slice(0, 6);
  if (!rows.length) return <p className="text-sm text-muted">{t("noLiabilities")}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.remaining)));
  return (
    <ul className="space-y-3">{rows.map((o) => (
      <li key={`${o.organiserId}|${o.currency}`}>
        <Link href={`/accounting/organisers/${o.organiserId}`} className="group block">
          <div className="flex items-baseline justify-between gap-3 text-sm"><span className="truncate font-medium group-hover:underline">{o.organiserName}</span><Money v={o.remaining} c={o.currency} strong className={o.remaining < 0 ? "text-fin-neg" : ""} /></div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"><span className={cn("block h-full rounded-full", o.remaining < 0 ? "bg-fin-neg" : "bg-fin-info")} style={{ width: `${(Math.abs(o.remaining) / max) * 100}%` }} /></div>
          {o.remaining < 0 && <span className="text-[11px] text-fin-neg">{t("owesBilit")}</span>}
        </Link>
      </li>
    ))}</ul>
  );
}
