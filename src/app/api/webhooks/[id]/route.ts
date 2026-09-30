import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@/db";
import { audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { authed, body } from "@/server/http";
import { tx, uuid, requireElevation } from "@/server/api";
import { WEBHOOK_EVENTS } from "@/server/webhooks/events";
import { resolveTarget } from "@/server/webhooks/deliver";
import { webhookView } from "@/server/webhooks/view";

const Patch = z.object({ url: z.string().url().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), enabled: z.boolean() }).partial();
const own = (orgId: string, id: string) => and(eq(schema.webhooks.id, uuid(id, "Webhook")), eq(schema.webhooks.organisationId, orgId));

export const PATCH = authed<{ id: string }>("webhooks.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, Patch);
  if (b.url) {
    requireElevation(auth);
    try { await resolveTarget(b.url); } catch (e) { throw new AppError("validation_failed", `That address cannot be used: ${e instanceof Error ? e.message : "invalid URL"}`); }
  }
  return tx(async (t) => {
    const [row] = await t.update(schema.webhooks).set(b).where(own(auth.organisationId, params.id)).returning();
    if (!row) throw notFound("Webhook");
    await audit(t, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "webhook.updated", ctx, metadata: { webhookId: row.id, fields: Object.keys(b) } });
    return webhookView(row);
  });
});

export const DELETE = authed<{ id: string }>("webhooks.manage", async ({ auth, ctx, params }) => {
  requireElevation(auth);
  await tx(async (t) => {
    const [row] = await t.delete(schema.webhooks).where(own(auth.organisationId, params.id)).returning({ id: schema.webhooks.id, url: schema.webhooks.url });
    if (!row) throw notFound("Webhook");
    await audit(t, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "webhook.deleted", ctx, metadata: { webhookId: row.id, url: row.url } });
  });
  return { ok: true };
});
