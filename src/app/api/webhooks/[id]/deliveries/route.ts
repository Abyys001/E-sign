import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { authed } from "@/server/http";
import { uuid } from "@/server/api";

const d = schema.webhookDeliveries;
export const GET = authed<{ id: string }>("webhooks.manage", async ({ auth, params }) => ({
  items: await db.select({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastStatusCode: d.lastStatusCode, lastError: d.lastError, deliveredAt: d.deliveredAt, createdAt: d.createdAt })
    .from(d).where(and(eq(d.webhookId, uuid(params.id, "Webhook")), eq(d.organisationId, auth.organisationId))).orderBy(desc(d.createdAt)).limit(100),
}));
