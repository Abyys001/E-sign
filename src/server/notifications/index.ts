import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";

export type NotificationType = "contract.awaiting_signature" | "contract.completed" | "contract.declined" | "contract.expired" | "contract.viewed" | "contract.signed" | "contract.cancelled" | "delivery.failed" | "retention.warning"
  | "intake.opened" | "intake.started" | "intake.returned" | "intake.submitted" | "intake.generation_failed" | "contract.ready_for_review";

export async function notifyUsers(tx: Tx, orgId: string, userIds: string[], type: NotificationType, contractId: string | null, data: Record<string, unknown>) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await tx.insert(schema.notifications).values(ids.map((userId) => ({ organisationId: orgId, userId, contractId, type, data })));
}

/** Users who should hear about a contract: its creator plus owners/admins/contract managers who can view it. */
export async function contractStakeholders(tx: Tx, orgId: string, creatorId: string): Promise<string[]> {
  const rows = await tx.select({ userId: schema.memberships.userId }).from(schema.memberships)
    .where(and(eq(schema.memberships.organisationId, orgId), sql`${schema.memberships.roleKey} in ('ORG_OWNER','ADMIN','CONTRACT_MANAGER')`));
  return [...new Set([creatorId, ...rows.map((r) => r.userId)])];
}

export const listNotifications = (orgId: string, userId: string, unreadOnly: boolean, limit = 50) =>
  db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.userId, userId), unreadOnly ? isNull(schema.notifications.readAt) : undefined))
    .orderBy(desc(schema.notifications.createdAt)).limit(limit);

export async function unreadCount(orgId: string, userId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return r?.n ?? 0;
}

export async function markRead(orgId: string, userId: string, ids: string[] | "all") {
  await db.update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt), ids === "all" ? undefined : sql`${schema.notifications.id} = any(${ids})`));
}
