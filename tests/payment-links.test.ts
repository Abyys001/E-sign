import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { DEFAULT_RULES } from "@/server/accounting/core";
import { extractEventCode, ticketQuantity } from "@/server/accounting/matcher";
import {
  checkoutParams, confirmCheckout, createLink, LinkInput, listLinks, priceFor, publicLink, saleDescription, setCheckoutFactory, startCheckout, updateLink, updateLinkSettings, type LinkRow,
} from "@/server/accounting/payment-links";
import { ctxFor, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";

const row = (over: Partial<LinkRow> = {}): LinkRow => ({
  id: "00000000-0000-0000-0000-000000000001", organisationId: "o", livemode: false, slug: "abcDEF123_-x", eventId: null, eventName: "Epic Wave Berlin", eventCode: "B41-0091",
  title: "General admission", description: "Doors 19:00", venue: "Berlin", eventDate: "2026-11-20", amount: 3500, currency: "eur", feeBps: 1000, adjustableQuantity: true, maxQuantity: 10,
  branding: { accentColor: "#e11d48", fontFamily: "inter", imageUrl: "https://example.com/p.jpg" }, status: "ACTIVE", expiresAt: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});
const opts = { quantity: 2, appUrl: "https://finance.example.test/", logoUrl: "https://finance.example.test/api/branding/logo/o", displayName: "Bilit", ticketQuantityKey: "quantity", withBranding: true };

describe("payment links — pure", () => {
  it("adds the booking fee on top of the price", () => {
    expect(priceFor(row(), 2)).toEqual({ unit: 3500, fee: 350, total: 7700 });
    expect(priceFor(row({ feeBps: 0 }), 1)).toEqual({ unit: 3500, fee: 0, total: 3500 });
  });

  it("builds a branded Checkout Session with the event, price, fee line and matching metadata", () => {
    const p = checkoutParams(row(), opts);
    expect(p.line_items).toEqual([
      { quantity: 2, price_data: { currency: "eur", unit_amount: 3500, product_data: { name: "Epic Wave Berlin — General admission", description: "2026-11-20 · Berlin · Doors 19:00", images: ["https://example.com/p.jpg"] } } },
      { quantity: 2, price_data: { currency: "eur", unit_amount: 350, product_data: { name: "Booking fee" } } },
    ]);
    expect(p.success_url).toBe("https://finance.example.test/pay/abcDEF123_-x/thanks?session_id={CHECKOUT_SESSION_ID}");
    expect(p.branding_settings).toEqual({ display_name: "Bilit", button_color: "#e11d48", background_color: "#252525", font_family: "inter", logo: { type: "url", url: opts.logoUrl } });
    expect(p.payment_intent_data?.metadata).toMatchObject({ event_code: "B41-0091", quantity: "2", payment_link_id: row().id });
    expect(checkoutParams(row(), { ...opts, withBranding: false }).branding_settings).toBeUndefined();
  });

  it("is matched to the event by the importer's default rules (metadata and description)", () => {
    const p = checkoutParams(row(), opts);
    const known = new Set(["B41-0091"]);
    expect(extractEventCode({ paymentIntentMetadata: p.payment_intent_data!.metadata as Record<string, string> }, DEFAULT_RULES, known)).toMatchObject({ ok: true, code: "B41-0091" });
    expect(extractEventCode({ description: saleDescription(row()) }, DEFAULT_RULES, known)).toMatchObject({ ok: true, code: "B41-0091" });
    expect(ticketQuantity(null, p.payment_intent_data!.metadata as Record<string, string>, "quantity")).toBe(2);
  });

  it("rejects bad branding input", () => {
    const base = { mode: "test", eventName: "X event", title: "Ticket", amount: 100, currency: "gbp" };
    expect(LinkInput.safeParse({ ...base, branding: { accentColor: "red" } }).success).toBe(false);
    expect(LinkInput.safeParse({ ...base, branding: { imageUrl: "http://insecure.test/a.png" } }).success).toBe(false);
    expect(LinkInput.safeParse({ ...base, branding: { accentColor: "#112233" } }).success).toBe(true);
  });
});

describe("payment links — flow", () => {
  let orgId = "", userId = "", eventId = "";
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  let paid = false;
  beforeAll(async () => {
    const { org, user } = await makeOrg("Payment links org");
    orgId = org.id; userId = user.id;
    const [e] = await db.insert(schema.acctEvents).values({ organisationId: orgId, name: "Gothenburg Night", code: `PL-${Math.floor(Math.random() * 1e6)}`, currency: "sek" }).returning();
    eventId = e!.id;
    setCheckoutFactory(() => ({
      ping: async () => undefined,
      create: async (p) => { created.push(p); return { id: `cs_test_${Math.random().toString(36).slice(2).padEnd(12, "x")}${created.length}`, url: "https://checkout.stripe.test/c/1", amount_total: 0 } as unknown as Stripe.Checkout.Session; },
      retrieve: async (id) => ({ id, metadata: created.at(-1)!.metadata, payment_status: paid ? "paid" : "unpaid", status: paid ? "complete" : "open", amount_total: 22000, customer_details: { email: "buyer@example.test", name: "Buyer" }, payment_intent: "pi_1" }) as unknown as Stripe.Checkout.Session,
    }));
    await updateLinkSettings({ orgId, userId, ctx: ctxFor() }, { mode: "test", apiKey: "rk_test_abcdefghijklmnop" });
  });
  afterAll(async () => { setCheckoutFactory(null); await stopBoss(); });

  it("creates a link for an event, sells through it, and locks the price once paid", async () => {
    const a = { orgId, userId, ctx: ctxFor() };
    await expect(createLink(a, LinkInput.parse({ mode: "test", eventId, eventName: "Gothenburg Night", title: "Ticket", amount: 10000, currency: "eur" }))).rejects.toThrow(/SEK/);
    const l = await createLink(a, LinkInput.parse({ mode: "test", eventId, eventName: "Gothenburg Night", title: "Ticket", amount: 10000, currency: "sek", feeBps: 1000, maxQuantity: 4 }));
    expect(l.eventCode).toMatch(/^PL-/);
    expect(l.url).toMatch(new RegExp(`/pay/${l.slug}$`));

    const pub = await publicLink(l.slug);
    expect(pub).toMatchObject({ available: true, eventName: "Gothenburg Night", unit: 10000, fee: 1000, test: true });

    const r = await startCheckout(l.slug, { quantity: 9 }, ctxFor());
    expect(r.url).toBe("https://checkout.stripe.test/c/1");
    expect(created.at(-1)!.line_items![0]!.quantity).toBe(4); // capped at the link's max

    const sessionId = (await db.select().from(schema.acctPaymentLinkSessions).where(eq(schema.acctPaymentLinkSessions.linkId, l.id)))[0]!.sessionId;
    expect(await confirmCheckout(l.slug, sessionId, ctxFor())).toMatchObject({ paid: false });
    paid = true;
    expect(await confirmCheckout(l.slug, sessionId, ctxFor())).toMatchObject({ paid: true, quantity: 4, amountTotal: 22000, email: "buyer@example.test" });

    const [item] = (await listLinks(orgId, "test")).items;
    expect(item).toMatchObject({ paid: 1, ticketsSold: 4, collected: 22000 });
    await expect(updateLink(a, l.id, { amount: 5000 })).rejects.toThrow(/locked/);
    await updateLink(a, l.id, { status: "DISABLED" });
    expect((await publicLink(l.slug))?.available).toBe(false);
    await expect(startCheckout(l.slug, { quantity: 1 }, ctxFor())).rejects.toThrow(/no longer available/);
  });

  it("ignores unknown slugs and sessions from other links", async () => {
    expect(await publicLink("nope")).toBeNull();
    expect(await confirmCheckout("abcdefghijkl", "cs_test_xxxxxxxxxxxxxxxx", ctxFor())).toBeNull();
  });
});
