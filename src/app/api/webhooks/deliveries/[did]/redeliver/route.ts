import { audit } from "@/server/audit";
import { authed } from "@/server/http";
import { tx, uuid } from "@/server/api";
import { notFound } from "@/server/errors";
import { redeliver } from "@/server/webhooks/deliver";

export const POST = authed<{ did: string }>("webhooks.manage", async ({ auth, ctx, params }) => {
  const d = await redeliver(auth.organisationId, uuid(params.did, "Delivery"));
  if (!d) throw notFound("Delivery");
  await tx((t) => audit(t, { organisationId: auth.organisationId, userId: auth.user.id, eventType: "webhook.redelivered", ctx, metadata: { deliveryId: d.id, event: d.event } }));
  return { ok: true };
});
