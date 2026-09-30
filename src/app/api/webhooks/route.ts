import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { authed, body } from "@/server/http";
import { tx, requireElevation } from "@/server/api";
import { WEBHOOK_EVENTS } from "@/server/webhooks/events";
import { newWebhookSecret, resolveTarget } from "@/server/webhooks/deliver";
import { webhookView } from "@/server/webhooks/view";

const Endpoint = z.object({ url: z.string().url().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), enabled: z.boolean().default(true) });

export const GET = authed("webhooks.manage", async ({ auth }) => ({ events: WEBHOOK_EVENTS, items: (await db.select().from(schema.webhooks).where(eq(schema.webhooks.organisationId, auth.organisationId)).orderBy(desc(schema.webhooks.createdAt))).map(webhookView) }));

/** The signing secret is returned once, here, and never again. */
export const POST = authed("webhooks.manage", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  const b = await body(req, Endpoint);
  try { await resolveTarget(b.url); } catch (e) { throw new AppError("validation_failed", `That address cannot be used: ${e instanceof Error ? e.message : "invalid URL"}`, [{ path: "url", message: "Use a public https:// address." }]); }
  const s = newWebhookSecret();
  const h = await tx(async (t) => {
    const [row] = await t.insert(schema.webhooks).values({ organisationId: auth.organisationId, url: b.url, events: b.events, enabled: b.enabled, secretEnc: s.enc }).returning();
    await audit(t, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "webhook.created", ctx, metadata: { webhookId: row!.id, url: b.url } });
    return row!;
  });
  return { ...webhookView(h), secret: s.secret };
});
