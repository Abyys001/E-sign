import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { audit } from "@/server/audit";
import { authed } from "@/server/http";
import { tx, uuid, requireElevation } from "@/server/api";
import { notFound } from "@/server/errors";
import { newWebhookSecret } from "@/server/webhooks/deliver";

export const POST = authed<{ id: string }>("webhooks.manage", async ({ auth, ctx, params }) => {
  requireElevation(auth);
  const s = newWebhookSecret();
  await tx(async (t) => {
    const [row] = await t.update(schema.webhooks).set({ secretEnc: s.enc }).where(and(eq(schema.webhooks.id, uuid(params.id, "Webhook")), eq(schema.webhooks.organisationId, auth.organisationId))).returning({ id: schema.webhooks.id });
    if (!row) throw notFound("Webhook");
    await audit(t, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "webhook.secret_rotated", ctx, metadata: { webhookId: row.id } });
  });
  return { secret: s.secret };
});
