import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { authed } from "@/server/http";
import { uuid } from "@/server/api";
import { notFound } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { deliverWebhook } from "@/server/webhooks/deliver";

/** Sends a real signed `webhook.test` request to the endpoint now and returns what the endpoint answered. */
export const POST = authed<{ id: string }>("webhooks.manage", async ({ auth, params }) => {
  await rateLimit("webhookTest", auth.user.id);
  const [h] = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.id, uuid(params.id, "Webhook")), eq(schema.webhooks.organisationId, auth.organisationId)));
  if (!h) throw notFound("Webhook");
  const [d] = await db.insert(schema.webhookDeliveries).values({ webhookId: h.id, organisationId: auth.organisationId, event: "webhook.test", eventKey: `test:${crypto.randomUUID()}`, payload: { type: "webhook.test", createdAt: new Date().toISOString(), organisationId: auth.organisationId, data: { message: "Test event from Bilit.event E-Sign" } } }).returning();
  return deliverWebhook(d!.id);
});
