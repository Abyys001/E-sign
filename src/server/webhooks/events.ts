import { and, eq, sql } from "drizzle-orm";
import { schema, type Tx } from "@/db";
import { enqueue, QUEUES } from "../jobs";

export const WEBHOOK_EVENTS = [
  "contract.created", "contract.sent", "contract.viewed", "contract.signed", "contract.completed", "contract.declined",
  "contract.cancelled", "contract.expired", "contract.voided", "recipient.added", "recipient.completed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Outbox: one delivery row per (endpoint, event occurrence) inside the business transaction, plus a job.
 * `eventKey` makes the operation idempotent: replaying the same business event can never create a duplicate delivery.
 */
export async function emitWebhook(tx: Tx, orgId: string, event: WebhookEvent, data: Record<string, unknown>, eventKey: string) {
  const hooks = await tx.select().from(schema.webhooks).where(and(eq(schema.webhooks.organisationId, orgId), eq(schema.webhooks.enabled, true), sql`${event} = any(${schema.webhooks.events})`));
  for (const h of hooks) {
    const [d] = await tx.insert(schema.webhookDeliveries).values({
      webhookId: h.id, organisationId: orgId, event, eventKey,
      payload: { id: undefined, type: event, createdAt: new Date().toISOString(), organisationId: orgId, data },
    }).onConflictDoNothing().returning({ id: schema.webhookDeliveries.id });
    if (d) await enqueue(tx, QUEUES.webhook, { deliveryId: d.id }, { singletonKey: d.id });
  }
}
