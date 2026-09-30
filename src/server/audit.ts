import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { canonicalJson } from "./canonical";
import { sha256 } from "./crypto";

export type RequestContext = { ip?: string | null; userAgent?: string | null; correlationId?: string | null; device?: Record<string, unknown> | null };

export type AuditInput = {
  organisationId: string;
  eventType: string;
  contractId?: string | null;
  userId?: string | null;
  recipientId?: string | null;
  metadata?: Record<string, unknown>;
  documentHash?: string | null;
  ctx?: RequestContext;
};

const entryHash = (prev: string | null, e: Record<string, unknown>) => sha256(`${prev ?? ""}|${canonicalJson(e)}`);

/** Append an audit event inside the caller's transaction. Chain is per contract (or per org when no contract). */
export async function audit(tx: Tx, input: AuditInput) {
  const chainKey = input.contractId ?? `org:${input.organisationId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${chainKey}, 0))`);
  const chain = input.contractId
    ? eq(schema.auditEvents.contractId, input.contractId)
    : and(eq(schema.auditEvents.organisationId, input.organisationId), sql`${schema.auditEvents.contractId} is null`);
  const [prev] = await tx.select({ hash: schema.auditEvents.hash }).from(schema.auditEvents).where(chain).orderBy(sql`seq desc`).limit(1);

  const occurredAt = new Date();
  const body = {
    organisationId: input.organisationId, contractId: input.contractId ?? null, userId: input.userId ?? null,
    recipientId: input.recipientId ?? null, eventType: input.eventType, occurredAt: occurredAt.toISOString(),
    ip: input.ctx?.ip ?? null, userAgent: input.ctx?.userAgent ?? null, metadata: input.metadata ?? {}, documentHash: input.documentHash ?? null,
  };
  const hash = entryHash(prev?.hash ?? null, body);
  const [row] = await tx.insert(schema.auditEvents).values({
    organisationId: body.organisationId, contractId: body.contractId, userId: body.userId, recipientId: body.recipientId,
    eventType: body.eventType, occurredAt, ip: body.ip, userAgent: body.userAgent, device: input.ctx?.device ?? null,
    correlationId: input.ctx?.correlationId ?? null, metadata: body.metadata, documentHash: body.documentHash,
    prevHash: prev?.hash ?? null, hash,
  }).returning();
  return row!;
}

/** Recompute the hash chain; returns the first broken seq or null if intact. */
export async function verifyAuditChain(contractId: string): Promise<{ ok: boolean; brokenAtSeq?: number; count: number }> {
  const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.contractId, contractId)).orderBy(asc(schema.auditEvents.seq));
  let prev: string | null = null;
  for (const r of rows) {
    const expected = entryHash(prev, {
      organisationId: r.organisationId, contractId: r.contractId, userId: r.userId, recipientId: r.recipientId, eventType: r.eventType,
      occurredAt: r.occurredAt.toISOString(), ip: r.ip, userAgent: r.userAgent, metadata: r.metadata, documentHash: r.documentHash,
    });
    if (r.prevHash !== prev || r.hash !== expected) return { ok: false, brokenAtSeq: r.seq, count: rows.length };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
