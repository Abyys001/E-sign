import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { applyBps } from "@/lib/money";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { rateLimit } from "../rate-limit";
import { getOrgBranding } from "../settings";
import { acctAudit, Currency, getAcctSettings, isLive, IsoDate, ModeSchema, modeOf, type Mode } from "./core";
import { getStripeAccount, safeStripeError } from "./stripe-gateway";

/**
 * Payment links: a branded public page at /pay/<slug> for one event and one price. "Pay" opens a Stripe Checkout Session
 * that carries the link's branding (logo, colours, display name), the event name and the price, plus the booking fee on
 * top as its own line. The PaymentIntent description is "Order (payment link) for event: NAME (CODE)" and its metadata
 * holds event_code + quantity, so the normal Stripe import matches each sale to the event without any extra step.
 *
 * Creating Checkout Sessions needs a key with "Checkout Sessions: Write" (and read). The read-only import key usually
 * lacks it, so a separate key can be stored per mode; without one the import key is tried.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
type Conn = { keyEnc?: string | null; keyHint?: string | null; lastTestedAt?: string | null; lastError?: string | null };
type Stored = Partial<Record<Mode, Conn>>;

export const FONTS = ["default", "inter", "montserrat", "lato", "open_sans", "roboto", "raleway", "nunito", "lora", "noto_sans", "pt_sans", "source_sans_pro"] as const;
export const BORDERS = ["rounded", "rectangular", "pill"] as const;
const Hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #E11D48");

/** Bilit's palette: used for any colour a link leaves empty. */
export const BRAND_DEFAULTS = { accent: "#20ac6a", secondary: "#e8f7ef", background: "#252525", card: "#f4f5f7", text: "#252525", header: "#252525" } as const;

export const LinkBranding = z.object({
  displayName: z.string().trim().max(60).optional().nullable(),
  accentColor: Hex.optional().nullable(), // primary: buttons, highlights
  secondaryColor: Hex.optional().nullable(), // soft panels (price summary)
  backgroundColor: Hex.optional().nullable(), // page background
  cardColor: Hex.optional().nullable(), // the card holding the event
  textColor: Hex.optional().nullable(),
  headerColor: Hex.optional().nullable(), // band behind the logo
  fontFamily: z.enum(FONTS).optional().nullable(),
  borderStyle: z.enum(BORDERS).optional().nullable(),
  imageUrl: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Use an https:// image address").optional().nullable(),
});
export type LinkBranding = z.infer<typeof LinkBranding>;

export const LinkInput = z.object({
  mode: ModeSchema,
  eventId: z.string().uuid().optional().nullable(),
  eventName: z.string().trim().min(2).max(120),
  eventCode: z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Letters, digits, . _ - only").optional().nullable(),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  venue: z.string().trim().max(120).optional().nullable(),
  eventDate: IsoDate.optional().nullable(),
  amount: z.number().int().positive().max(100_000_000),
  currency: Currency,
  feeBps: z.number().int().min(0).max(5000).default(0),
  adjustableQuantity: z.boolean().default(true),
  maxQuantity: z.number().int().min(1).max(99).default(10),
  branding: LinkBranding.default({}),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
});
export const LinkPatch = LinkInput.omit({ mode: true }).partial().extend({ status: z.enum(["ACTIVE", "DISABLED"]).optional() });

// ---------- Stripe seam ----------
type CheckoutApi = {
  create(p: Stripe.Checkout.SessionCreateParams, idempotencyKey: string): Promise<Stripe.Checkout.Session>;
  retrieve(id: string): Promise<Stripe.Checkout.Session>;
  ping(): Promise<void>;
};
type Factory = (key: string) => CheckoutApi;
const defaultFactory: Factory = (key) => {
  const s = new Stripe(key, { maxNetworkRetries: 2, timeout: 30_000, appInfo: { name: "bilit-finance" } });
  return {
    create: (p, idempotencyKey) => s.checkout.sessions.create(p, { idempotencyKey }),
    retrieve: (id) => s.checkout.sessions.retrieve(id),
    ping: async () => { await s.checkout.sessions.list({ limit: 1 }); },
  };
};
const g = globalThis as { __checkoutFactory?: Factory };
/** Test seam only. */
export const setCheckoutFactory = (f: Factory | null) => { g.__checkoutFactory = f ?? undefined; };

// ---------- settings ----------
async function stored(orgId: string): Promise<Stored> {
  await getAcctSettings(orgId);
  const [s] = await db.select({ v: schema.acctSettings.paymentLinkSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  return (s?.v ?? {}) as Stored;
}

/** The key used for Checkout: the dedicated payment-links key, else the Stripe import key. */
async function checkoutFor(orgId: string, mode: Mode): Promise<CheckoutApi> {
  const c = (await stored(orgId))[mode];
  let key = c?.keyEnc ? decrypt(c.keyEnc) : null;
  if (!key) {
    const a = await getStripeAccount(orgId, mode);
    if (a?.secretKeyEnc && a.status !== "DISCONNECTED") key = decrypt(a.secretKeyEnc);
  }
  if (!key) throw new AppError("config_missing", `Stripe ${mode} mode is not connected. Add a payment-links key on the Payment links page.`);
  return (g.__checkoutFactory ?? defaultFactory)(key);
}

export async function getLinkSettings(orgId: string, mode: Mode) {
  const c = (await stored(orgId))[mode] ?? {};
  const imp = await getStripeAccount(orgId, mode);
  return { mode, dedicatedKey: !!c.keyEnc, keyHint: c.keyHint ?? null, importKeyHint: imp?.keyHint ?? null, lastTestedAt: c.lastTestedAt ?? null, lastError: c.lastError ?? null };
}

export const LinkSettingsInput = z.object({
  mode: ModeSchema,
  apiKey: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s/g, "") : v), z.string().regex(/^(rk|sk)_(test|live)_[A-Za-z0-9]{10,}$/, "Paste the key exactly as Stripe shows it (rk_live_…)").nullable()),
});

/** Save (tested against Stripe) or remove (null) the payment-links key for one mode. */
export async function updateLinkSettings(a: Actor, input: z.infer<typeof LinkSettingsInput>) {
  const all = await stored(a.orgId);
  const prev = all[input.mode] ?? {};
  if (input.apiKey === null) all[input.mode] = {};
  else {
    const live = input.apiKey.includes("_live_");
    if (live !== (input.mode === "live")) throw new AppError("validation_failed", `That is a ${live ? "live" : "test"} key; you are in ${input.mode} mode.`, [{ path: "apiKey", message: "Wrong mode" }]);
    try { await (g.__checkoutFactory ?? defaultFactory)(input.apiKey).ping(); }
    catch (e) { throw new AppError("validation_failed", `Stripe refused the key: ${safeStripeError(e)}. It needs Checkout Sessions read + write.`, [{ path: "apiKey", message: "Rejected by Stripe" }]); }
    all[input.mode] = { keyEnc: encrypt(input.apiKey), keyHint: `${input.apiKey.slice(0, 8)}…${input.apiKey.slice(-4)}`, lastTestedAt: new Date().toISOString(), lastError: null };
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.acctSettings).set({ paymentLinkSettings: all }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: input.apiKey === null ? "payment_links.key_removed" : "payment_links.key_saved", old: { keyHint: prev.keyHint ?? null }, new: { keyHint: all[input.mode]?.keyHint ?? null }, extra: { mode: input.mode } });
  });
  return getLinkSettings(a.orgId, input.mode);
}

// ---------- pure helpers (unit-tested) ----------
export const newSlug = () => randomBytes(9).toString("base64url"); // 12 url-safe chars, 72 bits
export const SLUG_RE = /^[A-Za-z0-9_-]{8,40}$/;

export type LinkRow = typeof schema.acctPaymentLinks.$inferSelect;

/** Booking fee per item (added on top of the price) and the total for a quantity. */
export function priceFor(l: Pick<LinkRow, "amount" | "feeBps">, quantity: number) {
  const fee = l.feeBps ? applyBps(l.amount, l.feeBps) : 0;
  return { unit: l.amount, fee, total: (l.amount + fee) * quantity };
}

/** The Stripe description the importer's default rule reads: "… for event: NAME (CODE)". */
export const saleDescription = (l: Pick<LinkRow, "eventName" | "eventCode" | "title">) =>
  `Order (payment link) for event: ${l.eventName}${l.eventCode ? ` (${l.eventCode})` : ""} — ${l.title}`.slice(0, 1000);

/** Checkout Session parameters for one link + quantity. Pure: everything it needs is passed in. */
export function checkoutParams(l: LinkRow, o: { quantity: number; appUrl: string; logoUrl: string | null; displayName: string; ticketQuantityKey: string; withBranding: boolean }): Stripe.Checkout.SessionCreateParams {
  const { unit, fee } = priceFor(l, o.quantity);
  const b = LinkBranding.parse(l.branding ?? {});
  const base = o.appUrl.replace(/\/$/, "");
  const when = [l.eventDate, l.venue].filter(Boolean).join(" · ");
  const meta: Record<string, string> = { payment_link_id: l.id, payment_link_slug: l.slug, [o.ticketQuantityKey]: String(o.quantity), ...(l.eventCode ? { event_code: l.eventCode } : {}) };
  // The quantity is chosen on our page (not adjustable at Stripe), so the ticket count in the metadata is always right.
  const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
    quantity: o.quantity,
    price_data: { currency: l.currency, unit_amount: unit, product_data: { name: `${l.eventName} — ${l.title}`.slice(0, 250), ...(l.description || when ? { description: [when, l.description].filter(Boolean).join(" · ").slice(0, 500) } : {}), ...(b.imageUrl ? { images: [b.imageUrl] } : {}) } },
  }];
  if (fee) items.push({ quantity: o.quantity, price_data: { currency: l.currency, unit_amount: fee, product_data: { name: "Booking fee" } } });
  const p: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: items,
    success_url: `${base}/pay/${l.slug}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pay/${l.slug}`,
    customer_creation: "if_required",
    billing_address_collection: "auto",
    metadata: meta,
    payment_intent_data: { description: saleDescription(l), metadata: meta },
  };
  if (o.withBranding) {
    p.branding_settings = {
      display_name: (b.displayName || o.displayName).slice(0, 60),
      button_color: b.accentColor || BRAND_DEFAULTS.accent,
      background_color: b.backgroundColor || BRAND_DEFAULTS.background,
      ...(b.fontFamily ? { font_family: b.fontFamily } : {}),
      ...(b.borderStyle ? { border_style: b.borderStyle } : {}),
      ...(o.logoUrl ? { logo: { type: "url", url: o.logoUrl } } : {}),
    };
  }
  return p;
}

// ---------- admin ----------
const linkUrl = (slug: string) => `${env().APP_URL.replace(/\/$/, "")}/pay/${slug}`;

export async function listLinks(orgId: string, mode: Mode) {
  const L = schema.acctPaymentLinks, S = schema.acctPaymentLinkSessions;
  const rows = await db.select().from(L).where(and(eq(L.organisationId, orgId), eq(L.livemode, isLive(mode)))).orderBy(desc(L.createdAt)).limit(500);
  const stats = rows.length ? await db.select({ linkId: S.linkId, paid: sql<number>`count(*) filter (where ${S.status} = 'PAID')::int`, qty: sql<number>`coalesce(sum(${S.quantity}) filter (where ${S.status} = 'PAID'), 0)::int`, total: sql<number>`coalesce(sum(${S.amountTotal}) filter (where ${S.status} = 'PAID'), 0)::bigint`, open: sql<number>`count(*) filter (where ${S.status} = 'OPEN')::int` })
    .from(S).where(inArray(S.linkId, rows.map((r) => r.id))).groupBy(S.linkId) : [];
  const by = new Map(stats.map((s) => [s.linkId, s]));
  return { items: rows.map((r) => ({ ...view(r), paid: by.get(r.id)?.paid ?? 0, ticketsSold: by.get(r.id)?.qty ?? 0, collected: Number(by.get(r.id)?.total ?? 0), openSessions: by.get(r.id)?.open ?? 0 })) };
}

const view = (r: LinkRow) => ({ ...r, branding: LinkBranding.parse(r.branding ?? {}), url: linkUrl(r.slug), expired: !!r.expiresAt && r.expiresAt < new Date(), ...priceFor(r, 1) });

async function ownLink(orgId: string, id: string) {
  const [l] = await db.select().from(schema.acctPaymentLinks).where(and(eq(schema.acctPaymentLinks.id, id), eq(schema.acctPaymentLinks.organisationId, orgId)));
  if (!l) throw new AppError("not_found", "Payment link not found.");
  return l;
}

async function checkEvent(orgId: string, eventId: string | null | undefined, currency: string | undefined) {
  if (!eventId) return null;
  const [e] = await db.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, orgId)));
  if (!e) throw new AppError("validation_failed", "Event not found.", [{ path: "eventId", message: "Not found" }]);
  if (currency && currency !== e.currency) throw new AppError("validation_failed", `This event sells in ${e.currency.toUpperCase()}; use the same currency so sales match the event.`, [{ path: "currency", message: `Use ${e.currency.toUpperCase()}` }]);
  return e;
}

export async function createLink(a: Actor, input: z.infer<typeof LinkInput>) {
  const e = await checkEvent(a.orgId, input.eventId, input.currency);
  const { mode, expiresAt, ...rest } = input;
  return db.transaction(async (tx) => {
    const [l] = await tx.insert(schema.acctPaymentLinks).values({
      ...rest, organisationId: a.orgId, livemode: isLive(mode), slug: newSlug(), eventId: e?.id ?? null, eventCode: e?.code ?? input.eventCode ?? null,
      expiresAt: expiresAt ? new Date(expiresAt) : null, createdBy: a.userId,
    }).returning();
    await acctAudit(tx, { ...a, action: "payment_link.created", entity: "acct_payment_link", entityId: l!.id, new: { eventName: l!.eventName, amount: l!.amount, currency: l!.currency, feeBps: l!.feeBps } });
    return view(l!);
  });
}

export async function updateLink(a: Actor, id: string, patch: z.infer<typeof LinkPatch>) {
  const prev = await ownLink(a.orgId, id);
  const sold = await db.select({ n: sql<number>`count(*)::int` }).from(schema.acctPaymentLinkSessions).where(and(eq(schema.acctPaymentLinkSessions.linkId, id), eq(schema.acctPaymentLinkSessions.status, "PAID")));
  if ((sold[0]?.n ?? 0) > 0 && ((patch.amount !== undefined && patch.amount !== prev.amount) || (patch.currency && patch.currency !== prev.currency) || (patch.feeBps !== undefined && patch.feeBps !== prev.feeBps)))
    throw new AppError("invalid_state", "This link already has payments, so its price, fee and currency are locked. Create a new link for a new price.");
  const eventId = patch.eventId === undefined ? prev.eventId : patch.eventId;
  const e = await checkEvent(a.orgId, eventId, patch.currency ?? prev.currency);
  const { expiresAt, ...rest } = patch;
  return db.transaction(async (tx) => {
    const [l] = await tx.update(schema.acctPaymentLinks).set({
      ...rest, eventId: e?.id ?? null, ...(e ? { eventCode: e.code } : patch.eventCode !== undefined ? { eventCode: patch.eventCode } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}), updatedAt: new Date(),
    }).where(eq(schema.acctPaymentLinks.id, id)).returning();
    await acctAudit(tx, { ...a, action: patch.status && patch.status !== prev.status ? `payment_link.${patch.status === "ACTIVE" ? "enabled" : "disabled"}` : "payment_link.updated", entity: "acct_payment_link", entityId: id, old: { amount: prev.amount, status: prev.status }, new: { amount: l!.amount, status: l!.status } });
    return view(l!);
  });
}

export async function linkSessions(orgId: string, id: string) {
  await ownLink(orgId, id);
  const S = schema.acctPaymentLinkSessions;
  return { items: await db.select().from(S).where(eq(S.linkId, id)).orderBy(desc(S.createdAt)).limit(200) };
}

/** Events to pick from, with the booking fee % of their current agreement when the fee is added on top. */
export async function linkEvents(orgId: string) {
  const E = schema.acctEvents, A = schema.acctAgreements;
  const rows = await db.select({ id: E.id, name: E.name, code: E.code, currency: E.currency, startsOn: E.startsOn, status: E.status, percentBps: A.percentBps, basis: A.percentBasis })
    .from(E).leftJoin(A, eq(A.id, E.currentAgreementId)).where(and(eq(E.organisationId, orgId), inArray(E.status, ["ACTIVE", "INACTIVE"]))).orderBy(desc(E.startsOn));
  return { items: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, currency: r.currency, startsOn: r.startsOn, feeBps: r.basis === "ADDED" ? r.percentBps ?? 0 : 0 })) };
}

/** Re-check open checkouts with Stripe (paid / expired). */
export async function refreshSessions(orgId: string, mode: Mode, linkId?: string) {
  const L = schema.acctPaymentLinks, S = schema.acctPaymentLinkSessions;
  const open = await db.select({ s: S, l: L }).from(S).innerJoin(L, eq(L.id, S.linkId))
    .where(and(eq(L.organisationId, orgId), eq(L.livemode, isLive(mode)), eq(S.status, "OPEN"), ...(linkId ? [eq(L.id, linkId)] : []))).orderBy(desc(S.createdAt)).limit(100);
  if (!open.length) return { checked: 0, paid: 0 };
  const api = await checkoutFor(orgId, mode);
  let paid = 0;
  for (const { s, l } of open) {
    try { if ((await applySession(l, await api.retrieve(s.sessionId))) === "PAID") paid++; }
    catch (e) { log.warn("payment_links.refresh_failed", { session: s.sessionId, err: safeStripeError(e) }); }
  }
  return { checked: open.length, paid };
}

async function applySession(l: LinkRow, cs: Stripe.Checkout.Session) {
  if (cs.metadata?.payment_link_id !== l.id) throw new AppError("not_found", "This payment does not belong to this link.");
  const status = cs.payment_status === "paid" || cs.payment_status === "no_payment_required" ? "PAID" : cs.status === "expired" ? "EXPIRED" : "OPEN";
  await db.update(schema.acctPaymentLinkSessions).set({
    status, amountTotal: cs.amount_total ?? undefined,
    customerEmail: cs.customer_details?.email ?? null, customerName: cs.customer_details?.name ?? null,
    paymentIntentId: typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent?.id ?? null,
    ...(status === "PAID" ? { completedAt: sql`coalesce(${schema.acctPaymentLinkSessions.completedAt}, now())` } : {}),
  }).where(eq(schema.acctPaymentLinkSessions.sessionId, cs.id));
  return status;
}

// ---------- public ----------
const usable = (l: LinkRow | undefined): l is LinkRow => !!l && l.status === "ACTIVE" && (!l.expiresAt || l.expiresAt > new Date());

async function linkBySlug(slug: string) {
  if (!SLUG_RE.test(slug)) return undefined;
  const [l] = await db.select().from(schema.acctPaymentLinks).where(eq(schema.acctPaymentLinks.slug, slug));
  return l;
}

const LOGO_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/svg+xml": "svg" };

async function brandFor(orgId: string) {
  const b = await getOrgBranding(orgId);
  const [obj] = b.logoObjectId ? await db.select({ type: schema.storageObjects.contentType }).from(schema.storageObjects).where(eq(schema.storageObjects.id, b.logoObjectId)) : [];
  const ext = obj ? LOGO_EXT[obj.type.toLowerCase()] : undefined;
  return {
    displayName: b.displayName || b.orgName, logoUrl: b.logoObjectId ? `/api/branding/logo/${orgId}` : null,
    // Stripe only accepts a logo URL whose path ends in .png/.jpg/.svg; other formats are left off the checkout page
    checkoutLogoPath: ext ? `/api/branding/logo/${orgId}/logo.${ext}` : null,
    primaryColor: b.primaryColor, supportEmail: b.supportEmail || null,
  };
}

/** What the public page shows. Null = unknown slug; `available: false` = disabled or expired. */
export async function publicLink(slug: string) {
  const l = await linkBySlug(slug);
  if (!l) return null;
  const org = await brandFor(l.organisationId);
  const b = LinkBranding.parse(l.branding ?? {});
  return {
    available: usable(l), slug: l.slug, test: !l.livemode,
    eventName: l.eventName, title: l.title, description: l.description, venue: l.venue, eventDate: l.eventDate,
    currency: l.currency, adjustableQuantity: l.adjustableQuantity, maxQuantity: l.maxQuantity, ...priceFor(l, 1),
    brand: {
      displayName: b.displayName || org.displayName, logoUrl: org.logoUrl, imageUrl: b.imageUrl ?? null, supportEmail: org.supportEmail,
      accent: b.accentColor || BRAND_DEFAULTS.accent, secondary: b.secondaryColor || BRAND_DEFAULTS.secondary, background: b.backgroundColor || BRAND_DEFAULTS.background,
      card: b.cardColor || BRAND_DEFAULTS.card, text: b.textColor || BRAND_DEFAULTS.text, header: b.headerColor || BRAND_DEFAULTS.header,
    },
  };
}

export const CheckoutInput = z.object({ quantity: z.number().int().min(1).max(99).default(1) });

/** Start a Stripe Checkout for a public link. Rate-limited per IP; the link must be active and not expired. */
export async function startCheckout(slug: string, input: z.infer<typeof CheckoutInput>, ctx: RequestContext) {
  await rateLimit("payCheckout", ctx.ip ?? "unknown");
  const l = await linkBySlug(slug);
  if (!usable(l)) throw new AppError("not_found", "This payment link is no longer available.");
  const quantity = l.adjustableQuantity ? Math.min(input.quantity, l.maxQuantity) : 1;
  const [settings, org] = await Promise.all([getAcctSettings(l.organisationId), brandFor(l.organisationId)]);
  const appUrl = env().APP_URL;
  const logoUrl = org.checkoutLogoPath && appUrl.startsWith("https://") ? `${appUrl.replace(/\/$/, "")}${org.checkoutLogoPath}` : null;
  const api = await checkoutFor(l.organisationId, modeOf(l.livemode));
  const opts = { quantity, appUrl, logoUrl, displayName: org.displayName, ticketQuantityKey: settings.ticketQuantityKey, withBranding: true };
  const key = `bilit-plink-${l.id}-${randomBytes(8).toString("hex")}`;
  let cs: Stripe.Checkout.Session;
  try { cs = await api.create(checkoutParams(l, opts), key); }
  catch (e) {
    // a branding detail Stripe won't take (logo, colour, or no access to branding_settings): retry once without branding rather than refusing the buyer
    if (e instanceof Stripe.errors.StripeInvalidRequestError && /branding|logo|font|color|border/i.test(`${e.param ?? ""} ${e.message}`)) {
      log.warn("payment_links.branding_refused", { link: l.id, err: safeStripeError(e) });
      try { cs = await api.create(checkoutParams(l, { ...opts, withBranding: false }), `${key}-nb`); } catch (e2) { throw checkoutError(l, e2); }
    } else throw checkoutError(l, e);
  }
  if (!cs.url) throw new AppError("invalid_state", "Stripe did not return a checkout page.");
  await db.insert(schema.acctPaymentLinkSessions).values({ linkId: l.id, sessionId: cs.id, quantity, amountTotal: cs.amount_total ?? priceFor(l, quantity).total, currency: l.currency });
  return { url: cs.url };
}

function checkoutError(l: LinkRow, e: unknown) {
  log.error("payment_links.checkout_failed", { link: l.id, err: safeStripeError(e) });
  if (e instanceof Stripe.errors.StripePermissionError || e instanceof Stripe.errors.StripeAuthenticationError)
    return new AppError("invalid_state", "Payments for this link are not set up yet. Please contact the organiser.");
  return new AppError("invalid_state", "We couldn't open the payment page. Please try again in a moment.");
}

/** Thank-you page: confirm the session with Stripe (never trust the query string alone). */
export async function confirmCheckout(slug: string, sessionId: string, ctx: RequestContext) {
  await rateLimit("payCheckout", ctx.ip ?? "unknown");
  const l = await linkBySlug(slug);
  if (!l || !/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) return null;
  const [row] = await db.select().from(schema.acctPaymentLinkSessions).where(and(eq(schema.acctPaymentLinkSessions.sessionId, sessionId), eq(schema.acctPaymentLinkSessions.linkId, l.id)));
  if (!row) return null;
  let status = row.status;
  if (status === "OPEN") {
    try { status = await applySession(l, await (await checkoutFor(l.organisationId, modeOf(l.livemode))).retrieve(sessionId)); }
    catch (e) { log.warn("payment_links.confirm_failed", { link: l.id, err: safeStripeError(e) }); }
  }
  const [fresh] = await db.select().from(schema.acctPaymentLinkSessions).where(eq(schema.acctPaymentLinkSessions.id, row.id));
  return { paid: status === "PAID", quantity: fresh!.quantity, amountTotal: fresh!.amountTotal, currency: fresh!.currency, email: fresh!.customerEmail };
}
