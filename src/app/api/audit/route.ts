import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { authed, query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { exportAudit } from "@/server/audit-export";
import { can } from "@/server/rbac";
import { AppError } from "@/server/errors";

const Q = z.object({ type: z.string().max(80).optional(), contractId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), format: z.enum(["json", "csv"]).optional() });

export const GET = authed("contracts.audit", async ({ req, auth, ctx }) => {
  const q = query(req, Q.and(Pagination));
  if (q.format) {
    if (!can(auth.membership, "audit.export")) throw new AppError("forbidden", "You do not have permission to export audit data.");
    requireElevation(auth);
    const out = await exportAudit({ orgId: auth.organisationId, userId: auth.user.id, ctx, contractId: q.contractId, from: q.from, to: q.to, format: q.format });
    return new Response(out.body, { headers: { "content-type": out.contentType, "content-disposition": `attachment; filename="audit.${q.format}"`, "cache-control": "private, no-store" } });
  }
  const where = and(eq(schema.auditEvents.organisationId, auth.organisationId), q.type ? sql`${schema.auditEvents.eventType} like ${`${q.type.replace(/[%_]/g, "")}%`}` : undefined, q.contractId ? eq(schema.auditEvents.contractId, q.contractId) : undefined, q.from ? gte(schema.auditEvents.occurredAt, q.from) : undefined, q.to ? lte(schema.auditEvents.occurredAt, q.to) : undefined);
  const [items, [tot]] = await Promise.all([
    db.select({ e: schema.auditEvents, contractName: schema.contracts.name, reference: schema.contracts.reference, userName: schema.users.name }).from(schema.auditEvents).leftJoin(schema.contracts, eq(schema.contracts.id, schema.auditEvents.contractId)).leftJoin(schema.users, eq(schema.users.id, schema.auditEvents.userId)).where(where).orderBy(desc(schema.auditEvents.seq)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.auditEvents).where(where),
  ]);
  return { items: items.map((r) => ({ ...r.e, seq: Number(r.e.seq), contractName: r.contractName, reference: r.reference, userName: r.userName })), page: q.page, pageSize: q.pageSize, total: tot?.n ?? 0 };
});
