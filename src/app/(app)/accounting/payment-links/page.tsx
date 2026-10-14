"use client";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, KeyRound, Link2, Pencil, Plus, Power, RefreshCw, Ticket } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Badge, CopyText, Money, useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";
import { onAccent } from "@/components/pay/pay-page";
import { applyBps, bpsToPercent, formatMoney, parseMajor, percentToBps, toDecimalString } from "@/lib/money";

type Branding = { displayName?: string | null; accentColor?: string | null; secondaryColor?: string | null; cardColor?: string | null; textColor?: string | null; headerColor?: string | null; backgroundColor?: string | null; fontFamily?: string | null; borderStyle?: string | null; imageUrl?: string | null };
type PLink = {
  id: string; slug: string; url: string; kind: "EVENT" | "CUSTOM"; openAmount: boolean; minAmount: number | null; maxAmount: number | null; eventId: string | null; eventName: string; eventCode: string | null; title: string; description: string | null; venue: string | null; eventDate: string | null;
  amount: number; currency: string; feeBps: number; fee: number; adjustableQuantity: boolean; maxQuantity: number; branding: Branding; status: "ACTIVE" | "DISABLED"; expiresAt: string | null; expired: boolean;
  paid: number; ticketsSold: number; collected: number; openSessions: number; createdAt: string;
};
type Ev = { id: string; name: string; code: string; currency: string; startsOn: string | null; feeBps: number };
type KeyInfo = { dedicatedKey: boolean; keyHint: string | null; publishableKey: string | null; importKeyHint: string | null; lastTestedAt: string | null };
type Sess = { id: string; sessionId: string; quantity: number; amountTotal: number; currency: string; status: string; customerEmail: string | null; customerName: string | null; createdAt: string; completedAt: string | null };

const PALETTE = { accentColor: "#20ac6a", secondaryColor: "#e8f7ef", backgroundColor: "#252525", cardColor: "#f4f5f7", textColor: "#252525", headerColor: "#252525" };
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS = ["default", "inter", "montserrat", "lato", "open_sans", "roboto", "raleway", "nunito", "lora", "noto_sans", "pt_sans", "source_sans_pro"];
const BORDERS = ["rounded", "rectangular", "pill"];

export default function PaymentLinksPage() {
  const t = useTranslations("accounting.plinks");
  const toast = useToast();
  const { can } = useMe();
  const { mode, q } = useMode();
  const list = useApi<{ items: PLink[] }>(q("/api/accounting/payment-links"));
  const key = useApi<KeyInfo>(q("/api/accounting/payment-links/settings"));
  const [edit, setEdit] = useState<PLink | "EVENT" | "CUSTOM" | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [sessionsOf, setSessionsOf] = useState<PLink | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can("accounting.manage"), admin = can("accounting.admin");

  const refresh = async () => {
    setBusy(true);
    try { const r = await api<{ checked: number; paid: number }>(q("/api/accounting/payment-links/refresh"), { method: "POST" }); toast("ok", t("refreshed", { n: r.checked, paid: r.paid })); await list.reload(); }
    catch (e) { toast("error", errMsg(e)); } finally { setBusy(false); }
  };
  const toggle = async (l: PLink) => {
    try { await api(`/api/accounting/payment-links/${l.id}`, { method: "PATCH", json: { status: l.status === "ACTIVE" ? "DISABLED" : "ACTIVE" } }); toast("ok", l.status === "ACTIVE" ? t("disabled") : t("enabled")); await list.reload(); }
    catch (e) { toast("error", errMsg(e)); }
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={<>
        {manage && <Button loading={busy} onClick={refresh}><RefreshCw className="size-4" aria-hidden />{t("refresh")}</Button>}
        {admin && <Button onClick={() => setKeyOpen(true)}><KeyRound className="size-4" aria-hidden />{t("key")}</Button>}
        {manage && <Button onClick={() => setEdit("CUSTOM")}><Plus className="size-4" aria-hidden />{t("newCustom")}</Button>}
        {manage && <Button variant="primary" onClick={() => setEdit("EVENT")}><Plus className="size-4" aria-hidden />{t("new")}</Button>}
      </>} />
      {key.data && !key.data.publishableKey && <Callout tone="info" title={t("embedOffTitle")}>{t("embedOff")}</Callout>}
      {key.data && !key.data.dedicatedKey && <Callout tone="warn" title={t("keyWarnTitle")}>{t("keyWarn", { hint: key.data.importKeyHint ?? "—", mode: mode.toUpperCase() })}</Callout>}
      <Card><CardHeader title={t("listTitle")} description={t("listDesc")} />
        {list.error ? <div className="p-5"><Callout tone="warn">{errMsg(list.error)}</Callout></div>
          : !list.data ? <Skeleton className="m-5 h-32" />
          : !list.data.items.length ? <EmptyState icon={<Link2 className="size-6" aria-hidden />} title={t("emptyTitle")} description={t("emptyDesc")} action={manage ? <Button variant="primary" onClick={() => setEdit("EVENT")}><Plus className="size-4" aria-hidden />{t("new")}</Button> : undefined} />
          : <TableWrap><Table>
            <thead><tr><Th>{t("event")}</Th><Th className="text-end">{t("price")}</Th><Th>{t("status")}</Th><Th className="text-end">{t("sold")}</Th><Th>{t("link")}</Th><Th /></tr></thead>
            <tbody>{list.data.items.map((l) => <Tr key={l.id}>
              <Td><span className="flex items-center gap-2 font-medium"><span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: l.branding.accentColor ?? "var(--accent)" }} />{l.eventName}</span><span className="block text-xs text-muted">{l.kind === "CUSTOM" && <span className="me-1.5 rounded bg-surface-2 px-1.5 py-px font-medium">{t("customTag")}</span>}{l.title}{l.eventCode ? ` · ${l.eventCode}` : ""}{l.eventDate ? ` · ${l.eventDate}` : ""}</span></Td>
              <Td className="text-end">{l.openAmount ? <span className="font-medium">{t("payerChooses")}<span className="block text-xs text-muted"><Money v={l.minAmount} c={l.currency} /> – <Money v={l.maxAmount} c={l.currency} /></span></span> : <Money v={l.amount} c={l.currency} strong />}{l.fee > 0 && <span className="block text-xs text-muted">+ <Money v={l.fee} c={l.currency} /> {t("feeShort", { p: bpsToPercent(l.feeBps) })}</span>}</Td>
              <Td><Badge s={l.expired ? "EXPIRED" : l.status} /></Td>
              <Td className="text-end"><button type="button" className="text-end hover:underline" onClick={() => setSessionsOf(l)}><span className="block font-medium tabular-nums">{t("tickets", { n: l.ticketsSold })}</span><Money v={l.collected} c={l.currency} className="text-xs text-muted" /></button></Td>
              <Td className="max-w-72"><CopyText text={l.url} /></Td>
              <Td><span className="flex justify-end gap-1">
                <a href={l.url} target="_blank" rel="noreferrer" aria-label={t("open")} title={t("open")} className="grid size-8 place-items-center rounded-lg hover:bg-surface-2"><ExternalLink className="size-4" aria-hidden /></a>
                {manage && <button type="button" aria-label={t("edit")} title={t("edit")} onClick={() => setEdit(l)} className="grid size-8 place-items-center rounded-lg hover:bg-surface-2"><Pencil className="size-4" aria-hidden /></button>}
                {manage && <button type="button" aria-label={l.status === "ACTIVE" ? t("disable") : t("enable")} title={l.status === "ACTIVE" ? t("disable") : t("enable")} onClick={() => toggle(l)} className="grid size-8 place-items-center rounded-lg hover:bg-surface-2"><Power className={`size-4 ${l.status === "ACTIVE" ? "text-fin-pos" : "text-muted"}`} aria-hidden /></button>}
              </span></Td>
            </Tr>)}</tbody>
          </Table></TableWrap>}
      </Card>
      <Callout title={t("howTitle")}>{t("how")}</Callout>
      {edit && <LinkDialog link={typeof edit === "string" ? null : edit} kind={typeof edit === "string" ? edit : edit.kind} mode={mode} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void list.reload(); }} />}
      {keyOpen && <KeyDialog mode={mode} q={q} info={key.data ?? null} onClose={() => setKeyOpen(false)} onSaved={() => { setKeyOpen(false); void key.reload(); }} />}
      {sessionsOf && <SessionsDialog link={sessionsOf} onClose={() => setSessionsOf(null)} />}
    </div>
  );
}

function LinkDialog({ link, kind: initialKind, mode, onClose, onSaved }: { link: PLink | null; kind: "EVENT" | "CUSTOM"; mode: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.plinks");
  const c = useTranslations("common");
  const toast = useToast();
  const events = useApi<{ items: Ev[] }>("/api/accounting/payment-links/events");
  const locked = !!link && link.paid > 0;
  const [eventId, setEventId] = useState(link?.eventId ?? "");
  const [eventName, setEventName] = useState(link?.eventName ?? "");
  const [eventCode, setEventCode] = useState(link?.eventCode ?? "");
  const [kind, setKind] = useState<"EVENT" | "CUSTOM">(initialKind);
  const custom = kind === "CUSTOM";
  const [title, setTitle] = useState(link?.title ?? (initialKind === "CUSTOM" ? "Payment" : "General admission"));
  const [openAmount, setOpenAmount] = useState(link?.openAmount ?? false);
  const [minAmt, setMinAmt] = useState(link?.minAmount ? toDecimalString(link.minAmount, link.currency) : "1.00");
  const [maxAmt, setMaxAmt] = useState(link?.maxAmount ? toDecimalString(link.maxAmount, link.currency) : "1000.00");
  const [description, setDescription] = useState(link?.description ?? "");
  const [venue, setVenue] = useState(link?.venue ?? "");
  const [eventDate, setEventDate] = useState(link?.eventDate ?? "");
  const [currency, setCurrency] = useState(link?.currency ?? "gbp");
  const [price, setPrice] = useState(link ? toDecimalString(link.amount, link.currency) : "");
  const [fee, setFee] = useState(link ? bpsToPercent(link.feeBps) : "0");
  const [multi, setMulti] = useState(link?.adjustableQuantity ?? initialKind !== "CUSTOM");
  const [maxQty, setMaxQty] = useState(String(link?.maxQuantity ?? 10));
  const [expires, setExpires] = useState(link?.expiresAt ? link.expiresAt.slice(0, 10) : "");
  const [b, setB] = useState<Branding>(() => {
    const saved = Object.fromEntries(Object.entries(link?.branding ?? {}).filter(([, v]) => v != null && v !== ""));
    return { displayName: "", fontFamily: "default", borderStyle: "rounded", imageUrl: "", ...PALETTE, ...saved };
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ev = events.data?.items.find((e) => e.id === eventId);
  // choosing an event fills in its name, code, currency, date and booking fee
  useEffect(() => {
    if (!ev || (link && link.eventId === ev.id)) return;
    setEventName(ev.name); setEventCode(ev.code); setCurrency(ev.currency); if (ev.startsOn) setEventDate(ev.startsOn); if (!locked) setFee(bpsToPercent(ev.feeBps));
  }, [ev?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const amounts = useMemo(() => {
    try {
      const a = parseMajor(price, currency); const f = applyBps(a, percentToBps(fee || "0"));
      const range = openAmount ? { min: parseMajor(minAmt, currency), max: parseMajor(maxAmt, currency) } : null;
      return { a, f, range, ok: a > 0 && (!range || (range.min > 0 && range.max >= range.min)) };
    } catch { return { a: 0, f: 0, range: null, ok: false }; }
  }, [price, fee, currency, openAmount, minAmt, maxAmt]);
  const set = (k: keyof Branding) => (v: string) => setB((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const nul = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
      const json = {
        eventId: custom ? null : eventId || null, eventName, eventCode: custom ? null : nul(eventCode), title, description: nul(description), venue: custom ? null : nul(venue), eventDate: custom ? null : nul(eventDate),
        amount: parseMajor(price, currency), currency, feeBps: percentToBps(fee || "0"), adjustableQuantity: multi && !openAmount, maxQuantity: Number(maxQty) || 1,
        openAmount, minAmount: amounts.range?.min ?? null, maxAmount: amounts.range?.max ?? null,
        expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
        branding: { displayName: nul(b.displayName), accentColor: nul(b.accentColor), secondaryColor: nul(b.secondaryColor), backgroundColor: nul(b.backgroundColor), cardColor: nul(b.cardColor), textColor: nul(b.textColor), headerColor: nul(b.headerColor), fontFamily: b.fontFamily && b.fontFamily !== "default" ? b.fontFamily : null, borderStyle: nul(b.borderStyle), imageUrl: nul(b.imageUrl) },
      };
      const r = link ? await api<PLink>(`/api/accounting/payment-links/${link.id}`, { method: "PATCH", json }) : await api<PLink>("/api/accounting/payment-links", { json: { ...json, mode, kind } });
      if (!link) void navigator.clipboard?.writeText(r.url).catch(() => undefined);
      toast("ok", link ? t("saved") : t("created"));
      onSaved();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  const col = (k: keyof typeof PALETTE) => (HEX.test(b[k] ?? "") ? b[k]! : PALETTE[k]);
  const accent = col("accentColor");
  return (
    <Modal open size="xl" onClose={onClose} title={link ? t("editTitle") : custom ? t("newCustomTitle") : t("newTitle")} description={t("dialogDesc", { mode: mode.toUpperCase() })}
      footer={<><Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!eventName.trim() || !title.trim() || !amounts.ok} onClick={save}>{link ? t("save") : t("create")}</Button></>}>
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-5">
          {!link && <div role="radiogroup" aria-label={t("kind")} className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-1">
            {(["EVENT", "CUSTOM"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); if (k === "CUSTOM") { setEventId(""); setEventCode(""); if (title === "General admission") setTitle("Payment"); setMulti(false); } else if (title === "Payment") setTitle("General admission"); }}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${kind === k ? "bg-surface shadow-card" : "text-muted hover:text-fg"}`}>{t(`kinds.${k}`)}<span className="block text-xs font-normal text-muted">{t(`kindsHint.${k}`)}</span></button>)}
          </div>}
          {custom ? <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("secCustom")}</legend>
            <div className="sm:col-span-2"><Field label={t("customName")} hint={t("customNameHint")} required>{(p) => <Input {...p} value={eventName} maxLength={120} placeholder={t("customNamePh")} onChange={(e) => setEventName(e.target.value)} />}</Field></div>
            <div className="sm:col-span-2"><Field label={t("description")}>{(p) => <Textarea {...p} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />}</Field></div>
          </fieldset> : <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("secEvent")}</legend>
            <div className="sm:col-span-2"><Field label={t("pickEvent")} hint={t("pickEventHint")}>{(p) => <Select {...p} value={eventId} onChange={(e) => setEventId(e.target.value)}><option value="">{t("noEvent")}</option>{events.data?.items.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code}) · {e.currency.toUpperCase()}</option>)}</Select>}</Field></div>
            <Field label={t("eventName")} required>{(p) => <Input {...p} value={eventName} maxLength={120} onChange={(e) => setEventName(e.target.value)} />}</Field>
            <Field label={t("eventCode")} hint={t("eventCodeHint")}>{(p) => <Input {...p} value={eventCode} maxLength={64} disabled={!!eventId} onChange={(e) => setEventCode(e.target.value)} />}</Field>
            <Field label={t("eventDate")}>{(p) => <Input {...p} type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />}</Field>
            <Field label={t("venue")}>{(p) => <Input {...p} value={venue} maxLength={120} onChange={(e) => setVenue(e.target.value)} />}</Field>
            <div className="sm:col-span-2"><Field label={t("description")}>{(p) => <Textarea {...p} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />}</Field></div>
          </fieldset>}
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("secPrice")}</legend>
            <div className="sm:col-span-2"><Checkbox checked={openAmount} disabled={locked} onChange={(e) => setOpenAmount(e.target.checked)} label={t("openAmount")} /></div>
            {openAmount && <div className="grid grid-cols-2 gap-2 sm:col-span-2">
              <Field label={t("minAmount")} required>{(p) => <Input {...p} inputMode="decimal" value={minAmt} disabled={locked} onChange={(e) => setMinAmt(e.target.value)} />}</Field>
              <Field label={t("maxAmount")} required>{(p) => <Input {...p} inputMode="decimal" value={maxAmt} disabled={locked} onChange={(e) => setMaxAmt(e.target.value)} />}</Field>
            </div>}
            <Field label={custom ? t("customTitle") : t("itemTitle")} required>{(p) => <Input {...p} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Field label={openAmount ? t("suggested") : t("price")} required>{(p) => <Input {...p} inputMode="decimal" value={price} disabled={locked} placeholder="35.00" onChange={(e) => setPrice(e.target.value)} />}</Field>
              <Field label={t("currency")}>{(p) => <Input {...p} value={currency} maxLength={3} disabled={locked || !!eventId} className="uppercase" onChange={(e) => setCurrency(e.target.value.toLowerCase())} />}</Field>
            </div>
            <Field label={custom ? t("feeCustom") : t("fee")} hint={amounts.ok && amounts.f ? t("feeHint", { fee: formatMoney(amounts.f, currency), total: formatMoney(amounts.a + amounts.f, currency) }) : t("feeHint0")}>{(p) => <Input {...p} inputMode="decimal" value={fee} disabled={locked} onChange={(e) => setFee(e.target.value)} />}</Field>
            <Field label={t("expires")} hint={t("expiresHint")}>{(p) => <Input {...p} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}</Field>
            {!openAmount && <div className="flex items-end gap-4 sm:col-span-2">
              <Checkbox checked={multi} onChange={(e) => setMulti(e.target.checked)} label={t("multi")} />
              {multi && <div className="w-28"><Field label={t("maxQty")}>{(p) => <Input {...p} type="number" min={1} max={99} value={maxQty} onChange={(e) => setMaxQty(e.target.value)} />}</Field></div>}
            </div>}
            {locked && <div className="sm:col-span-2"><Callout tone="warn">{t("locked")}</Callout></div>}
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("secBrand")}</legend>
            <Field label={t("displayName")} hint={t("displayNameHint")}>{(p) => <Input {...p} value={b.displayName ?? ""} maxLength={60} onChange={(e) => set("displayName")(e.target.value)} />}</Field>
            <ColorField label={t("accent")} value={b.accentColor ?? ""} onChange={set("accentColor")} />
            <ColorField label={t("secondary")} value={b.secondaryColor ?? ""} onChange={set("secondaryColor")} />
            <ColorField label={t("background")} value={b.backgroundColor ?? ""} onChange={set("backgroundColor")} />
            <ColorField label={t("card")} value={b.cardColor ?? ""} onChange={set("cardColor")} />
            <ColorField label={t("text")} value={b.textColor ?? ""} onChange={set("textColor")} />
            <ColorField label={t("header")} value={b.headerColor ?? ""} onChange={set("headerColor")} />
            <div className="sm:col-span-2"><Button size="sm" variant="ghost" onClick={() => setB((x) => ({ ...x, ...PALETTE }))}>{t("resetPalette")}</Button></div>
            <Field label={t("font")} hint={t("stripeOnly")}>{(p) => <Select {...p} value={b.fontFamily ?? "default"} onChange={(e) => set("fontFamily")(e.target.value)}>{FONTS.map((f) => <option key={f} value={f}>{f === "default" ? t("fontDefault") : f.replace(/_/g, " ")}</option>)}</Select>}</Field>
            <Field label={t("border")} hint={t("stripeOnly")}>{(p) => <Select {...p} value={b.borderStyle ?? "rounded"} onChange={(e) => set("borderStyle")(e.target.value)}>{BORDERS.map((x) => <option key={x} value={x}>{t(`borders.${x}`)}</option>)}</Select>}</Field>
            <Field label={t("image")} hint={t("imageHint")}>{(p) => <Input {...p} type="url" value={b.imageUrl ?? ""} placeholder="https://…" onChange={(e) => set("imageUrl")(e.target.value)} />}</Field>
          </fieldset>
          {err && <Callout tone="warn">{err}</Callout>}
        </div>
        <aside aria-label={t("preview")} className="lg:sticky lg:top-0 lg:self-start">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t("preview")}</p>
          <div className="rounded-2xl p-3" style={{ backgroundColor: col("backgroundColor") }}>
            <div className="overflow-hidden rounded-xl" style={{ backgroundColor: col("cardColor"), color: col("textColor") }}>
              <div className="flex items-center gap-2 px-3 py-2" style={{ backgroundColor: col("headerColor"), color: onAccent(col("headerColor")) }}>
                <span className="grid size-5 place-items-center rounded text-[10px] font-bold" style={{ backgroundColor: accent, color: onAccent(accent) }}>{(b.displayName || t("orgName")).slice(0, 1)}</span>
                <span className="text-xs font-semibold">{b.displayName || t("orgName")}</span>
              </div>
              <div className="h-1" style={{ backgroundColor: accent }} />
              <div className="space-y-2 p-3">
                <p className="text-base font-semibold leading-tight">{eventName || t("eventName")}</p>
                <p className="flex items-center gap-1 text-xs font-medium">{!custom && <Ticket className="size-3.5" style={{ color: accent }} aria-hidden />}{title}</p>
                {!custom && (eventDate || venue) && <p className="text-xs opacity-70">{[eventDate, venue].filter(Boolean).join(" · ")}</p>}
                <div className="flex justify-between rounded-lg px-2 py-1.5 text-xs" style={{ backgroundColor: col("secondaryColor") }}><span>{t("total")}</span><span className="font-semibold tabular-nums">{!amounts.ok ? "—" : openAmount ? t("payerChooses") : formatMoney(amounts.a + amounts.f, currency)}</span></div>
                <div className="rounded-full py-1.5 text-center text-xs font-semibold" style={{ backgroundColor: accent, color: onAccent(accent) }}>{t("payNow")}</div>
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">{t("previewNote")}</p>
        </aside>
      </div>
    </Modal>
  );
}

function ColorField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} hint={hint}>{(p) => <div className="flex gap-2">
      <input type="color" aria-label={label} value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff"} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-line bg-surface p-1" />
      <Input {...p} value={value} maxLength={7} placeholder="#RRGGBB" onChange={(e) => onChange(e.target.value)} />
    </div>}</Field>
  );
}

function KeyDialog({ mode, q, info, onClose, onSaved }: { mode: string; q: (u: string) => string; info: KeyInfo | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("accounting.plinks");
  const c = useTranslations("common");
  const toast = useToast();
  const [k, setK] = useState("");
  const [pk, setPk] = useState(info?.publishableKey ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const put = async (apiKey: string | null | undefined) => {
    setBusy(true); setErr(null);
    try { await api(q("/api/accounting/payment-links/settings"), { method: "PUT", json: { mode, apiKey, publishableKey: pk.trim() || null } }); toast("ok", apiKey === null ? t("keyRemoved") : t("keySaved")); onSaved(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={t("keyTitle", { mode: mode.toUpperCase() })} description={t("keyDesc")}
      footer={<>{info?.dedicatedKey && <Button variant="ghost" disabled={busy} onClick={() => put(null)}>{t("keyRemove")}</Button>}<Button onClick={onClose}>{c("cancel")}</Button><Button variant="primary" loading={busy} disabled={!k.trim() && pk.trim() === (info?.publishableKey ?? "")} onClick={() => put(k.trim() || undefined)}>{t("keySave")}</Button></>}>
      <div className="space-y-4">
        <p className="text-sm">{info?.dedicatedKey ? t("keyCurrent", { hint: info.keyHint ?? "" }) : t("keyNone", { hint: info?.importKeyHint ?? "—" })}</p>
        <Field label={t("keyLabel")} hint={t("keyHint")}>{(p) => <Input {...p} value={k} autoComplete="off" spellCheck={false} placeholder={mode === "live" ? "rk_live_…" : "rk_test_…"} onChange={(e) => setK(e.target.value)} />}</Field>
        <Field label={t("pkLabel")} hint={t("pkHint")}>{(p) => <Input {...p} value={pk} autoComplete="off" spellCheck={false} placeholder={mode === "live" ? "pk_live_…" : "pk_test_…"} onChange={(e) => setPk(e.target.value)} />}</Field>
        {err && <Callout tone="warn">{err}</Callout>}
      </div>
    </Modal>
  );
}

function SessionsDialog({ link, onClose }: { link: PLink; onClose: () => void }) {
  const t = useTranslations("accounting.plinks");
  const s = useApi<{ items: Sess[] }>(`/api/accounting/payment-links/${link.id}/sessions`);
  return (
    <Modal open size="lg" onClose={onClose} title={t("sessionsTitle", { name: link.eventName })} description={t("sessionsDesc")}>
      {!s.data ? <Skeleton className="h-32" /> : !s.data.items.length ? <p className="text-sm text-muted">{t("noSessions")}</p> : (
        <TableWrap><Table>
          <thead><tr><Th>{t("when")}</Th><Th>{t("buyer")}</Th><Th className="text-end">{t("qty")}</Th><Th className="text-end">{t("amount")}</Th><Th>{t("status")}</Th></tr></thead>
          <tbody>{s.data.items.map((x) => <Tr key={x.id}>
            <Td className="whitespace-nowrap">{new Date(x.completedAt ?? x.createdAt).toLocaleString()}</Td>
            <Td>{x.customerName ?? "—"}{x.customerEmail && <span className="block text-xs text-muted">{x.customerEmail}</span>}</Td>
            <Td className="text-end tabular-nums">{x.quantity}</Td>
            <Td className="text-end"><Money v={x.amountTotal} c={x.currency} /></Td>
            <Td><Badge s={x.status} /></Td>
          </Tr>)}</tbody>
        </Table></TableWrap>
      )}
    </Modal>
  );
}
