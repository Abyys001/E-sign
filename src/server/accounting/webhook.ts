import Stripe from "stripe";
import { eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt } from "../crypto";
import { AppError } from "../errors";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { rateLimit } from "../rate-limit";

const verifier = new Stripe("sk_test_signature_verification_only"); // the key is never used for API calls; webhooks.* is offline HMAC

/**
 * POST /api/webhooks/stripe. Nothing in the body is trusted until its Stripe-Signature verifies against one of the
 * configured endpoint secrets (that also identifies the organisation and mode). The Stripe event id makes delivery
 * idempotent: a redelivery returns 200 without doing anything. Processing happens in the worker, which re-fetches
 * the referenced object from the API.
 */
export async function receiveStripeWebhook(raw: string, signature: string | null, ip: string) {
  if (!signature) { await rateLimit("stripeWebhookBad", ip); throw new AppError("bad_request", "Missing Stripe-Signature header."); }
  if (raw.length > 1_000_000) throw new AppError("payload_too_large", "Payload too large.");
  const accounts = await db.select().from(schema.stripeAccounts).where(isNotNull(schema.stripeAccounts.webhookSecretEnc));
  let event: Stripe.Event | null = null, acc: (typeof accounts)[number] | null = null;
  for (const a of accounts) {
    try { event = verifier.webhooks.constructEvent(raw, signature, decrypt(a.webhookSecretEnc!)); acc = a; break; } catch { /* try the next configured endpoint */ }
  }
  if (!event || !acc) {
    log.security("stripe_webhook_signature_invalid", { ip });
    await rateLimit("stripeWebhookBad", ip);
    throw new AppError("bad_request", "Invalid signature.");
  }
  if (event.livemode !== acc.livemode) {
    log.security("stripe_webhook_mode_mismatch", { ip, eventId: event.id });
    throw new AppError("bad_request", "Event mode does not match the endpoint.");
  }
  const objectId = (event.data?.object as { id?: string } | undefined)?.id ?? null;
  const ins = await db.insert(schema.stripeEvents).values({
    organisationId: acc.organisationId, stripeAccountRef: acc.id, livemode: event.livemode, eventId: event.id, type: event.type, objectId,
    apiVersion: event.api_version ?? null, stripeCreatedAt: new Date(event.created * 1000),
  }).onConflictDoNothing().returning({ id: schema.stripeEvents.id });
  await db.update(schema.stripeAccounts).set({ lastWebhookAt: new Date(), lastWebhookType: event.type }).where(eq(schema.stripeAccounts.id, acc.id));
  if (!ins.length) return { received: true, duplicate: true };
  await enqueue(null, QUEUES.acctStripeEvent, { eventRowId: ins[0]!.id }, { singletonKey: `${acc.id}:${event.id}` });
  return { received: true };
}

/** Webhook health for the settings screen: last event, failures in the last 24 h. */
export async function webhookHealth(accountRef: string) {
  const r = await db.execute<{ total: number; failed: number; last: Date | null; last_type: string | null }>(sql`
    select count(*)::int as total, count(*) filter (where status = 'FAILED')::int as failed, max(received_at) as last,
      (select type from stripe_events where stripe_account_ref = ${accountRef} order by received_at desc limit 1) as last_type
    from stripe_events where stripe_account_ref = ${accountRef} and received_at > now() - interval '24 hours'`);
  return r.rows[0] ?? { total: 0, failed: 0, last: null, last_type: null };
}
