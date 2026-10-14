import { schema, type Tx, type db as Db } from "@/db";

type Logger = Pick<typeof Db, "insert"> | Tx;
export type TreasuryAuditInput = {
  orgId: string;
  actorType: "STAFF" | "ADMIN" | "SYSTEM";
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  resource?: string | null;
  resourceId?: string | null;
  outcome: "OK" | "DENY" | "FAIL";
  ip?: string | null;
  metadata?: Record<string, unknown>;
};

/** Append-only audit of every sensitive treasury action. Never records passwords, Stripe secrets or full card numbers. */
export async function logTreasury(tx: Logger, i: TreasuryAuditInput) {
  await tx.insert(schema.treasuryAudit).values({
    organisationId: i.orgId, actorType: i.actorType, actorId: i.actorId ?? null, actorName: i.actorName ?? null,
    action: i.action, resource: i.resource ?? null, resourceId: i.resourceId ?? null, outcome: i.outcome, ip: i.ip ?? null,
    metadata: scrub(i.metadata ?? {}),
  });
}

const SECRET_KEYS = /pass|secret|token|cvc|cvv|pan|number|key/i;
function scrub(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  return out;
}
