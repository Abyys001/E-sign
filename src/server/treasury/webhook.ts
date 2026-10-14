import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt } from "../crypto";
import { log } from "../logger";
import { rateLimit } from "../rate-limit";
import { AppError } from "../errors";
import { logTreasury } from "./audit";
import { treasuryGateway, type TreasuryStored } from "./stripe";

/**
 * Stripe Issuing webhooks for the treasury portal. The signature is verified against every configured Treasury endpoint
 * secret before anything is read; an event id already seen returns without acting (idempotent). Processing only mirrors
 * card status/controls locally — money is never moved from a webhook.
 */
export async function receiveTreasuryWebhook(raw: string, signature: string | null, ip: string) {
  // find the org+mode whose webhook secret verifies this payload
  const rows = await db.select({ orgId: schema.acctSettings.organisationId, v: schema.acctSettings.treasurySettings }).from(schema.acctSettings);
  let event: Stripe.Event | null = null;
  let orgId = "", mode: "test" | "live" = "test";
  outer: for (const r of rows) {
    const stored = (r.v ?? {}) as TreasuryStored;
    for (const m of ["test", "live"] as const) {
      const c = stored[m] as (TreasuryStored["test"] & { webhookSecretEnc?: string | null }) | undefined;
      if (!c?.keyEnc) continue;
      const secretEnc = c.webhookSecretEnc;
      if (!secretEnc) continue;
      try {
        const gw = await treasuryGateway(r.orgId, m);
        const e = gw.constructEvent(raw, signature, decrypt(secretEnc));
        if (typeof e.livemode === "boolean" && e.livemode !== (m === "live")) continue; // a test event never acts on live data
        event = e; orgId = r.orgId; mode = m; break outer;
      } catch { /* try the next configured endpoint */ }
    }
  }
  if (!event) { await rateLimit("stripeWebhookBad", ip).catch(() => {}); throw new AppError("validation_failed", "Signature verification failed."); }

  // idempotency: record the event id; a redelivery is a no-op
  const [inserted] = await db.insert(schema.treasuryStripeEvents).values({ organisationId: orgId, stripeEventId: event.id, type: event.type }).onConflictDoNothing().returning({ id: schema.treasuryStripeEvents.id });
  if (!inserted) return { received: true, duplicate: true };

  try {
    await process(orgId, mode, event);
    await db.update(schema.treasuryStripeEvents).set({ processedAt: new Date() }).where(eq(schema.treasuryStripeEvents.id, inserted.id));
  } catch (e) {
    // forget the event so Stripe's retry is processed rather than treated as a duplicate, and answer 5xx so it retries
    await db.delete(schema.treasuryStripeEvents).where(eq(schema.treasuryStripeEvents.id, inserted.id));
    log.error("treasury.webhook_process_failed", { eventId: event.id, error: e instanceof Error ? e.message : String(e) });
    throw new AppError("internal", "Webhook processing failed; Stripe will retry.");
  }
  return { received: true };
}

async function process(orgId: string, mode: "test" | "live", event: Stripe.Event) {
  void mode;
  if (event.type === "issuing_card.updated" || event.type === "issuing_card.created") {
    const card = event.data.object as Stripe.Issuing.Card;
    await db.update(schema.treasuryCards)
      .set({ status: card.status, spendingControls: (card.spending_controls ?? {}) as unknown as Record<string, unknown>, last4: card.last4, updatedAt: new Date() })
      .where(and(eq(schema.treasuryCards.organisationId, orgId), eq(schema.treasuryCards.stripeCardId, card.id)));
    await logTreasury(db, { orgId, actorType: "SYSTEM", action: `webhook.${event.type}`, resource: "card", resourceId: card.id, outcome: "OK", metadata: { status: card.status } });
  } else if (event.type.startsWith("issuing_authorization.") || event.type.startsWith("issuing_transaction.")) {
    // activity is always read live from Stripe when a staff member opens their card; nothing to store here.
    await logTreasury(db, { orgId, actorType: "SYSTEM", action: `webhook.${event.type}`, resource: "issuing", resourceId: (event.data.object as { id?: string }).id ?? null, outcome: "OK" });
  }
}
