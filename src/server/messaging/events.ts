import { and, eq, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "../audit";
import { hmac } from "../crypto";
import { env } from "@/lib/env";
import { contractStakeholders, notifyUsers } from "../notifications";
import { lockContract, transition } from "../contracts/service";

export type EmailEventType = "DELIVERED" | "BOUNCE" | "COMPLAINT" | "OPEN" | "CLICK";

/** Shared secret for the inbound provider-event endpoint (derive, so no extra env var is needed). */
export const inboundEventsSecret = () => hmac(env().WEBHOOK_SECRET, "inbound-email-events");

/**
 * Provider-independent delivery status. SMTP acceptance is recorded as SENT only; DELIVERED/BOUNCED come from provider
 * events posted to /api/webhooks/email-events (SES, SendGrid, Postmark, Mailgun adapters normalise to this shape).
 */
export async function recordEmailEvent(ev: { messageId: string; type: EmailEventType; at?: Date; detail?: unknown }) {
  const [msg] = await db.select().from(schema.emailMessages).where(or(eq(schema.emailMessages.id, isUuid(ev.messageId) ? ev.messageId : "00000000-0000-0000-0000-000000000000"), eq(schema.emailMessages.messageId, ev.messageId)));
  if (!msg) return false;
  await db.transaction(async (tx) => {
    // A redelivered provider event hits the unique index and changes nothing: no second notification, audit entry or status move.
    const inserted = await tx.insert(schema.emailEvents).values({ emailMessageId: msg.id, organisationId: msg.organisationId, type: ev.type, payload: (ev.detail ?? {}) as object, occurredAt: ev.at ?? new Date() }).onConflictDoNothing().returning({ id: schema.emailEvents.id });
    if (!inserted.length) return;
    const at = ev.at ?? new Date();
    if (ev.type === "OPEN") await tx.update(schema.emailMessages).set({ openedAt: sql`coalesce(${schema.emailMessages.openedAt}, ${at})` }).where(eq(schema.emailMessages.id, msg.id));
    if (ev.type === "CLICK") await tx.update(schema.emailMessages).set({ clickedAt: sql`coalesce(${schema.emailMessages.clickedAt}, ${at})`, openedAt: sql`coalesce(${schema.emailMessages.openedAt}, ${at})` }).where(eq(schema.emailMessages.id, msg.id));
    if (ev.type === "DELIVERED" && msg.status === "SENT") {
      await tx.update(schema.emailMessages).set({ status: "DELIVERED", deliveredAt: at }).where(eq(schema.emailMessages.id, msg.id));
      if (msg.contractId && msg.template === "signature_requested") {
        const c = await lockContract(tx, msg.organisationId, msg.contractId);
        if (c.status === "SENT") await transition(tx, { orgId: c.organisationId }, c, "DELIVERED", {});
      }
    }
    if (ev.type === "BOUNCE" || ev.type === "COMPLAINT") {
      await tx.update(schema.emailMessages).set({ status: ev.type === "BOUNCE" ? "BOUNCED" : "COMPLAINED", bouncedAt: at, error: JSON.stringify(ev.detail ?? {}).slice(0, 400) }).where(eq(schema.emailMessages.id, msg.id));
      await tx.insert(schema.emailSuppressions).values({ organisationId: msg.organisationId, email: msg.toEmail.toLowerCase(), reason: ev.type, sourceMessageId: msg.id }).onConflictDoNothing();
      if (msg.contractId) {
        const [c] = await tx.select().from(schema.contracts).where(and(eq(schema.contracts.id, msg.contractId), eq(schema.contracts.organisationId, msg.organisationId)));
        if (c) {
          await notifyUsers(tx, msg.organisationId, await contractStakeholders(tx, msg.organisationId, c.createdBy), "delivery.failed", c.id, { to: msg.toEmail, template: msg.template, error: ev.type.toLowerCase(), contractName: c.name });
          await audit(tx, { organisationId: msg.organisationId, contractId: c.id, recipientId: msg.recipientId, eventType: `email.${ev.type.toLowerCase()}`, metadata: { to: msg.toEmail, template: msg.template } });
        }
      }
    }
    if (ev.type === "OPEN" && msg.contractId) await audit(tx, { organisationId: msg.organisationId, contractId: msg.contractId, recipientId: msg.recipientId, eventType: "email.opened", metadata: { template: msg.template } });
  });
  return true;
}
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
