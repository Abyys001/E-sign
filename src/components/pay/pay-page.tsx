"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, CalendarDays, CheckCircle2, Loader2, Lock, MapPin, Minus, Plus, Ticket, XCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { applyBps, formatMoney, parseMajor, toDecimalString } from "@/lib/money";
import type { publicLink } from "@/server/accounting/payment-links";

export type PublicLink = NonNullable<Awaited<ReturnType<typeof publicLink>>>;

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
/** Readable text on a colour: Bilit dark grey or white, whichever contrasts more (WCAG). */
export function onAccent(hex: string) { return contrast(hex, "#252525") >= contrast(hex, "#ffffff") ? "#252525" : "#ffffff"; }

function Shell({ link, children }: { link: PublicLink; children: React.ReactNode }) {
  const t = useTranslations("accounting.plinks.pub");
  const b = link.brand;
  const onBg = onAccent(b.background), onHeader = onAccent(b.header);
  // Brand colours are applied explicitly (not theme tokens) so the page looks the same in light and dark mode.
  const vars = { "--pl-accent": b.accent, "--pl-on-accent": onAccent(b.accent), "--pl-soft": b.secondary, "--pl-card": b.card, "--pl-text": b.text, "--pl-muted": `color-mix(in srgb, ${b.text} 68%, ${b.card})`, "--pl-line": `color-mix(in srgb, ${b.text} 14%, ${b.card})` } as React.CSSProperties;
  return (
    <div className="min-h-dvh" style={{ backgroundColor: b.background, color: onBg, ...vars }}>
    <main className="mx-auto flex w-full max-w-lg flex-col px-4 py-8 sm:py-14">
      <section className="overflow-hidden rounded-3xl shadow-[0_24px_60px_-24px_rgb(0_0_0/0.6)]" style={{ backgroundColor: b.card, color: b.text }}>
        <header className="flex items-center gap-3 px-6 py-4 sm:px-8" style={{ backgroundColor: b.header, color: onHeader }}>
          {b.logoUrl ? <img src={b.logoUrl} alt="" className="h-9 w-auto max-w-40 rounded-md object-contain" /> : <span className="grid size-9 place-items-center rounded-xl text-lg font-semibold" style={{ backgroundColor: b.accent, color: onAccent(b.accent) }}>{b.displayName.slice(0, 1)}</span>}
          <span className="text-base font-semibold">{b.displayName}</span>
          {link.test && <span className="ms-auto rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ backgroundColor: b.secondary, color: b.text }}>{t("test")}</span>}
        </header>
        <div className="h-1" style={{ backgroundColor: b.accent }} />
        <div className="space-y-5 p-6 sm:p-8">{children}</div>
      </section>
      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs opacity-75"><Lock className="size-3.5" aria-hidden />{t("secure")}</p>
      {b.supportEmail && <p className="mt-2 text-center text-xs opacity-75">{t.rich("help", { a: (x) => <a className="underline" href={`mailto:${b.supportEmail}`}>{x}</a>, email: b.supportEmail })}</p>}
    </main>
    </div>
  );
}

function EventHead({ link }: { link: PublicLink }) {
  const locale = useLocale();
  const custom = link.kind === "CUSTOM";
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{link.eventName}</h1>
      <p className="flex items-center gap-2 text-sm font-medium">{!custom && <Ticket className="size-4" style={{ color: link.brand.accent }} aria-hidden />}{link.title}</p>
      {!custom && (link.eventDate || link.venue) && <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--pl-muted)]">
        {link.eventDate && <span className="flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{new Date(`${link.eventDate}T12:00:00Z`).toLocaleDateString(locale === "fa" ? "fa-IR" : "en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</span>}
        {link.venue && <span className="flex items-center gap-1.5"><MapPin className="size-4" aria-hidden />{link.venue}</span>}
      </div>}
      {link.description && <p className="whitespace-pre-line pt-1 text-sm leading-relaxed text-[var(--pl-muted)]">{link.description}</p>}
    </div>
  );
}

type StripeJs = { createEmbeddedCheckoutPage?: (o: { fetchClientSecret: () => Promise<string> }) => Promise<Embedded>; initEmbeddedCheckout?: (o: { fetchClientSecret: () => Promise<string> }) => Promise<Embedded> };
type Embedded = { mount: (el: HTMLElement) => void; destroy: () => void };
type Start = { url: string } | { clientSecret: string; publishableKey: string };

let stripeJs: Promise<(pk: string) => StripeJs> | null = null;
/** Stripe.js must be loaded from js.stripe.com (PCI); loaded once, only when the buyer starts paying. */
const loadStripe = () => (stripeJs ??= new Promise((resolve, reject) => {
  const w = window as unknown as { Stripe?: (pk: string) => StripeJs };
  if (w.Stripe) return resolve(w.Stripe);
  const el = document.createElement("script");
  el.src = "https://js.stripe.com/clover/stripe.js"; el.async = true;
  el.onload = () => (w.Stripe ? resolve(w.Stripe) : reject(new Error("Stripe did not load")));
  el.onerror = () => { stripeJs = null; reject(new Error("Couldn't load the secure payment form. Check your connection and try again.")); };
  document.head.appendChild(el);
}));

/** Stripe's embedded checkout, mounted inside our branded card. */
function EmbeddedCheckout({ clientSecret, publishableKey }: { clientSecret: string; publishableKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let ec: Embedded | null = null, gone = false;
    (async () => {
      try {
        const stripe = (await loadStripe())(publishableKey);
        const make = stripe.createEmbeddedCheckoutPage ?? stripe.initEmbeddedCheckout;
        if (!make) throw new Error("Stripe embedded checkout is unavailable.");
        ec = await make.call(stripe, { fetchClientSecret: async () => clientSecret });
        if (gone) ec.destroy(); else if (ref.current) { ec.mount(ref.current); setReady(true); }
      } catch (e) { if (!gone) setErr(errMsg(e)); }
    })();
    return () => { gone = true; ec?.destroy(); };
  }, [clientSecret, publishableKey]);
  if (err) return <p role="alert" className="rounded-xl bg-[#fde8e8] p-3 text-sm text-[#b42318]">{err}</p>;
  // Stripe mounts into an EMPTY element; the spinner is a sibling shown until Stripe's frame is in place
  return (
    <div className="relative -mx-2 min-h-96 sm:-mx-4">
      {!ready && <Loader2 className="absolute inset-x-0 top-16 mx-auto size-6 animate-spin opacity-60" aria-hidden />}
      <div ref={ref} />
    </div>
  );
}

export function PayPage({ link }: { link: PublicLink }) {
  const t = useTranslations("accounting.plinks.pub");
  const locale = useLocale();
  const [qty, setQty] = useState(1);
  const [amountText, setAmountText] = useState(link.openAmount ? toDecimalString(link.unit, link.currency) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState<{ clientSecret: string; publishableKey: string } | null>(null);
  const m = (v: number) => formatMoney(v, link.currency, locale);
  const max = link.adjustableQuantity && !link.openAmount ? link.maxQuantity : 1;
  const chosen = useMemo(() => { if (!link.openAmount) return link.unit; try { return parseMajor(amountText, link.currency); } catch { return 0; } }, [amountText, link]);
  const inRange = !link.openAmount || (chosen >= (link.minAmount ?? 1) && chosen <= (link.maxAmount ?? 0));
  const fee = link.openAmount ? (link.feeBps ? applyBps(chosen, link.feeBps) : 0) : link.fee;
  const total = (chosen + fee) * qty;
  const pay = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<Start>(`/api/pay/${link.slug}/checkout`, { json: { quantity: qty, ...(link.openAmount ? { amount: chosen } : {}) } });
      if ("clientSecret" in r) { setEmbedded(r); setBusy(false); } else window.location.assign(r.url);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  if (!link.available) return <Shell link={link}><EventHead link={link} /><p className="flex items-center gap-2 rounded-2xl bg-[var(--pl-soft)] p-4 text-sm"><XCircle className="size-4 shrink-0 text-[var(--pl-muted)]" aria-hidden />{t("unavailable")}</p></Shell>;
  if (embedded) return (
    <Shell link={link}>
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-lg font-semibold leading-tight">{link.eventName}</p><p className="text-sm text-[var(--pl-muted)]">{qty > 1 ? `${qty} × ` : ""}{link.title} · {m(total)}</p></div>
        <button type="button" onClick={() => setEmbedded(null)} className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--pl-line)] px-3 py-1.5 text-xs font-medium"><ArrowLeft className="size-3.5" aria-hidden />{t("change")}</button>
      </div>
      <EmbeddedCheckout clientSecret={embedded.clientSecret} publishableKey={embedded.publishableKey} />
    </Shell>
  );
  return (
    <Shell link={link}>
      <EventHead link={link} />
      <dl className="space-y-2 rounded-2xl bg-[var(--pl-soft)] p-4 text-sm">
        {link.openAmount ? <div className="space-y-1.5">
          <dt><label htmlFor="pl-amount" className="font-medium">{t("yourAmount")}</label></dt>
          <dd>
            <div className="flex items-center rounded-xl border border-[var(--pl-line)] bg-white/70 px-3 focus-within:outline-2 focus-within:outline-offset-1" style={{ outlineColor: link.brand.accent }}>
              <span className="text-[var(--pl-muted)]">{link.currency.toUpperCase()}</span>
              <input id="pl-amount" inputMode="decimal" autoComplete="off" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={!inRange} aria-describedby="pl-amount-hint" className="h-12 w-full bg-transparent px-2 text-xl font-semibold tabular-nums outline-none" />
            </div>
            <p id="pl-amount-hint" className={`mt-1 text-xs ${inRange ? "text-[var(--pl-muted)]" : "text-[#b42318]"}`}>{t("range", { min: m(link.minAmount ?? 0), max: m(link.maxAmount ?? 0) })}</p>
          </dd>
        </div> : <div className="flex justify-between"><dt className="text-[var(--pl-muted)]">{t("price")}</dt><dd className="tabular-nums">{m(link.unit)}</dd></div>}
        {fee > 0 && <div className="flex justify-between"><dt className="text-[var(--pl-muted)]">{link.kind === "CUSTOM" ? t("serviceFee") : t("fee")}</dt><dd className="tabular-nums">{m(fee)}</dd></div>}
        {max > 1 && <div className="flex items-center justify-between pt-1"><dt className="text-[var(--pl-muted)]">{t("quantity")}</dt><dd className="flex items-center gap-1">
          <button type="button" aria-label={t("less")} disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))} className="grid size-9 place-items-center rounded-full border border-[var(--pl-line)] disabled:opacity-40"><Minus className="size-4" aria-hidden /></button>
          <span className="w-8 text-center text-base font-semibold tabular-nums" aria-live="polite">{qty}</span>
          <button type="button" aria-label={t("more")} disabled={qty >= max} onClick={() => setQty((q) => Math.min(max, q + 1))} className="grid size-9 place-items-center rounded-full border border-[var(--pl-line)] disabled:opacity-40"><Plus className="size-4" aria-hidden /></button>
        </dd></div>}
        <div className="flex items-baseline justify-between border-t border-[var(--pl-line)] pt-3"><dt className="font-medium">{t("total")}</dt><dd className="text-xl font-semibold tabular-nums">{inRange ? m(total) : "—"}</dd></div>
      </dl>
      {err && <p role="alert" className="rounded-xl bg-[#fde8e8] p-3 text-sm text-[#b42318]">{err}</p>}
      <button type="button" onClick={pay} disabled={busy || !inRange || chosen <= 0} className="flex h-12 w-full items-center justify-center gap-2 rounded-full text-base font-semibold transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60" style={{ backgroundColor: link.brand.accent, color: onAccent(link.brand.accent), outlineColor: link.brand.accent }}>
        {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />}{inRange ? t("pay", { amount: m(total) }) : t("payPlain")}
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
      {err ? <p className="flex items-center gap-2 text-sm"><XCircle className="size-5 text-[#b42318]" aria-hidden />{err}</p>
        : !r ? <p className="flex items-center gap-2 text-sm text-[var(--pl-muted)]"><Loader2 className="size-5 animate-spin" aria-hidden />{t("checking")}</p>
        : r.paid ? <div className="space-y-3 text-center">
            <CheckCircle2 className="mx-auto size-12" style={{ color: link.brand.accent }} aria-hidden />
            <h1 className="text-2xl font-semibold">{t("thanks")}</h1>
            <p className="text-sm text-[var(--pl-muted)]">{t("paidFor", { qty: r.quantity, title: link.title, event: link.eventName, amount: formatMoney(r.amountTotal, r.currency, locale) })}</p>
            {r.email && <p className="text-sm text-[var(--pl-muted)]">{t("receipt", { email: r.email })}</p>}
          </div>
        : <p className="flex items-center gap-2 text-sm text-[var(--pl-muted)]"><Loader2 className="size-5 animate-spin" aria-hidden />{t("pending")}</p>}
    </Shell>
  );
}
