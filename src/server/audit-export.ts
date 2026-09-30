import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { verifyAuditChain, audit, type RequestContext } from "./audit";
import { sha256 } from "./crypto";

const CSV_HEAD = ["seq", "id", "occurred_at_utc", "event_type", "contract_id", "user_id", "recipient_id", "ip", "user_agent", "document_hash", "correlation_id", "prev_hash", "hash", "metadata"];
/** CSV cells starting with = + - @ are spreadsheet formulas; prefix them so an exported audit log cannot execute anything. */
export const csvCell = (v: unknown) => { let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

export async function exportAudit(a: { orgId: string; userId: string; ctx: RequestContext; contractId?: string; from?: Date; to?: Date; format: "csv" | "json" }) {
  const where = and(eq(schema.auditEvents.organisationId, a.orgId), a.contractId ? eq(schema.auditEvents.contractId, a.contractId) : undefined, a.from ? gte(schema.auditEvents.occurredAt, a.from) : undefined, a.to ? lte(schema.auditEvents.occurredAt, a.to) : undefined);
  const rows = await db.select().from(schema.auditEvents).where(where).orderBy(asc(schema.auditEvents.seq)).limit(50_000);
  const chain = a.contractId ? await verifyAuditChain(a.contractId) : null;
  const body = a.format === "json"
    ? JSON.stringify({ exportedAt: new Date().toISOString(), contractId: a.contractId ?? null, chainIntact: chain?.ok ?? null, count: rows.length, events: rows.map((r) => ({ ...r, seq: Number(r.seq) })) }, null, 2)
    : [CSV_HEAD.join(","), ...rows.map((r) => [r.seq, r.id, r.occurredAt.toISOString(), r.eventType, r.contractId, r.userId, r.recipientId, r.ip, r.userAgent, r.documentHash, r.correlationId, r.prevHash, r.hash, r.metadata].map(csvCell).join(","))].join("\n");
  await db.transaction((tx) => audit(tx, { organisationId: a.orgId, contractId: a.contractId ?? null, userId: a.userId, eventType: "audit.exported", ctx: a.ctx, metadata: { format: a.format, rows: rows.length, sha256: sha256(body) } }));
  return { body, rows: rows.length, contentType: a.format === "json" ? "application/json" : "text/csv; charset=utf-8" };
}
export { sql };
