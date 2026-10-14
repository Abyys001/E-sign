"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays, CheckCircle2, Loader2, Lock, MapPin, Minus, Plus, Ticket, XCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import type { publicLink } from "@/server/accounting/payment-links";

export type PublicLink = NonNullable<Awaited<ReturnType<typeof publicLink>>>;

/** Readable text on the accent colour: dark on light accents, white on dark ones (WCAG relative luminance). */
export function onAccent(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? "#0d0d12" : "#ffffff";
}

function Shell({ link, children }: { link: PublicLink; children: React.ReactNode }) {
  const t = useTranslations("accounting.plinks.pub");
  const b = link.brand;
  return (
    <div className="min-h-dvh" style={b.background ? { backgroundColor: b.background } : undefined}>
    <main className="mx-auto flex w-full max-w-lg flex-col px-4 py-8 sm:py-14">
      <header className="mb-6 flex items-center gap-3">
        {b.logoUrl ? <img src={b.logoUrl} alt="" className="h-10 w-auto max-w-40 object-contain" /> : <span className="grid size-10 place-items-center rounded-xl text-lg font-semibold" style={{ backgroundColor: b.accent, color: onAccent(b.accent) }}>{b.displayName.slice(0, 1)}</span>}
        <span className="text-base font-semibold">{b.displayName}</span>
        {link.test && <span className="ms-auto rounded-full bg-fin-warn/15 px-2.5 py-0.5 text-xs font-medium text-fin-warn">{t("test")}</span>}
      </header>
      <section className="overflow-hidden rounded-3xl border border-line bg-surface shadow-[var(--shadow)]">
        <div className="h-1.5" style={{ backgroundColor: b.accent }} />
        <div className="space-y-5 p-6 sm:p-8">{children}</div>
      </section>
      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted"><Lock className="size-3.5" aria-hidden />{t("secure")}</p>
      {b.supportEmail && <p className="mt-2 text-center text-xs text-muted">{t.rich("help", { a: (x) => <a className="underline" href={`mailto:${b.supportEmail}`}>{x}</a>, email: b.supportEmail })}</p>}
    </main>
    </div>
  );
}

function EventHead({ link }: { link: PublicLink }) {
  const locale = useLocale();
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{link.eventName}</h1>
      <p className="flex items-center gap-2 text-sm font-medium" style={{ color: link.brand.accent }}><Ticket className="size-4" aria-hidden />{link.title}</p>
      {(link.eventDate || link.venue) && <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        {link.eventDate && <span className="flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{new Date(`${link.eventDate}T12:00:00Z`).toLocaleDateString(locale === "fa" ? "fa-IR" : "en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</span>}
        {link.venue && <span className="flex items-center gap-1.5"><MapPin className="size-4" aria-hidden />{link.venue}</span>}
      </div>}
      {link.description && <p className="whitespace-pre-line pt-1 text-sm leading-relaxed text-muted">{link.description}</p>}
    </div>
  );
}

export function PayPage({ link }: { link: PublicLink }) {
  const t = useTranslations("accounting.plinks.pub");
  const locale = useLocale();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = (v: number) => formatMoney(v, link.currency, locale);
  const max = link.adjustableQuantity ? link.maxQuantity : 1;
  const pay = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ url: string }>(`/api/pay/${link.slug}/checkout`, { json: { quantity: qty } }); window.location.assign(r.url); }
    catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  if (!link.available) return <Shell link={link}><EventHead link={link} /><p className="flex items-center gap-2 rounded-2xl bg-surface-2 p-4 text-sm"><XCircle className="size-4 shrink-0 text-muted" aria-hidden />{t("unavailable")}</p></Shell>;
  return (
    <Shell link={link}>
      <EventHead link={link} />
      <dl className="space-y-2 rounded-2xl bg-surface-2 p-4 text-sm">
        <div className="flex justify-between"><dt className="text-muted">{t("price")}</dt><dd className="tabular-nums">{m(link.unit)}</dd></div>
        {link.fee > 0 && <div className="flex justify-between"><dt className="text-muted">{t("fee")}</dt><dd className="tabular-nums">{m(link.fee)}</dd></div>}
        {max > 1 && <div className="flex items-center justify-between pt-1"><dt className="text-muted">{t("quantity")}</dt><dd className="flex items-center gap-1">
          <button type="button" aria-label={t("less")} disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))} className="grid size-9 place-items-center rounded-full border border-line disabled:opacity-40"><Minus className="size-4" aria-hidden /></button>
          <span className="w-8 text-center text-base font-semibold tabular-nums" aria-live="polite">{qty}</span>
          <button type="button" aria-label={t("more")} disabled={qty >= max} onClick={() => setQty((q) => Math.min(max, q + 1))} className="grid size-9 place-items-center rounded-full border border-line disabled:opacity-40"><Plus className="size-4" aria-hidden /></button>
        </dd></div>}
        <div className="flex items-baseline justify-between border-t border-line pt-3"><dt className="font-medium">{t("total")}</dt><dd className="text-xl font-semibold tabular-nums">{m((link.unit + link.fee) * qty)}</dd></div>
      </dl>
      {err && <p role="alert" className="rounded-xl bg-fin-neg/10 p-3 text-sm text-fin-neg">{err}</p>}
      <button type="button" onClick={pay} disabled={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-full text-base font-semibold transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60" style={{ backgroundColor: link.brand.accent, color: onAccent(link.brand.accent), outlineColor: link.brand.accent }}>
        {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />}{t("pay", { amount: m((link.unit + link.fee) * qty) })}
      </button>
    </Shell>
  );
}

type Confirmed = { paid: boolean; quantity: number; amountTotal: number; currency: string; email: string | null };

export function PayThanks({ link, sessionId }: { link: PublicLink; sessionId: string }) {
  const t = useTranslations("accounting.plinks.pub");
  const locale = useLocale();
  const [r, setR] = useState<Confirmed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false, tries = 0;
    const check = async () => {
      try { const x = await api<Confirmed>(`/api/pay/${link.slug}/confirm?session_id=${encodeURIComponent(sessionId)}`); if (stop) return; setR(x); if (!x.paid && ++tries < 5) setTimeout(check, 3000); }
      catch (e) { if (!stop) setErr(errMsg(e)); }
    };
    void check();
    return () => { stop = true; };
  }, [link.slug, sessionId]);
  return (
    <Shell link={link}>
      {err ? <p className="flex items-center gap-2 text-sm"><XCircle className="size-5 text-fin-neg" aria-hidden />{err}</p>
        : !r ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-5 animate-spin" aria-hidden />{t("checking")}</p>
        : r.paid ? <div className="space-y-3 text-center">
            <CheckCircle2 className="mx-auto size-12" style={{ color: link.brand.accent }} aria-hidden />
            <h1 className="text-2xl font-semibold">{t("thanks")}</h1>
            <p className="text-sm text-muted">{t("paidFor", { qty: r.quantity, title: link.title, event: link.eventName, amount: formatMoney(r.amountTotal, r.currency, locale) })}</p>
            {r.email && <p className="text-sm text-muted">{t("receipt", { email: r.email })}</p>}
          </div>
        : <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-5 animate-spin" aria-hidden />{t("pending")}</p>}
    </Shell>
  );
}
