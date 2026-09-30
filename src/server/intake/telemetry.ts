import { and, desc, eq, gte } from "drizzle-orm";
import { schema, type Tx } from "@/db";

export const VISIT_GAP_MS = 30 * 60_000; // a return after this much inactivity is a new "open"
export const ACTIVE_WINDOW_MS = 2 * 60_000; // "currently active" = activity within this window
export const BEAT_MIN_INTERVAL_MS = 15_000; // heartbeats closer than this are ignored (no write)
export const MAX_ACTIVE_DELTA_S = 90; // credit at most this much active time per heartbeat

export type AccessEventType =
  | "intake.opened" | "intake.session_started" | "intake.session_resumed" | "intake.returned" | "intake.form_started" | "intake.field_interaction"
  | "intake.draft_saved" | "intake.submission_started" | "intake.submitted" | "intake.session_expired" | "intake.link_expired" | "intake.link_revoked"
  | "intake.verification_failed" | "intake.verified";

export async function recordAccessEvent(tx: Tx, e: { orgId: string; formId: string; invitationId: string; sessionId?: string | null; type: AccessEventType; ip?: string | null; metadata?: Record<string, unknown> }) {
  await tx.insert(schema.intakeAccessEvents).values({ organisationId: e.orgId, formId: e.formId, invitationId: e.invitationId, sessionId: e.sessionId ?? null, type: e.type, ip: e.ip ?? null, metadata: e.metadata ?? {} });
}

/** True if this (invitation, type) was already recorded since `since`. Keeps rarely-meaningful events (expired/revoked probes) from flooding the table. */
export async function recentlyRecorded(tx: Tx, invitationId: string, type: AccessEventType, since: Date): Promise<boolean> {
  const [r] = await tx.select({ id: schema.intakeAccessEvents.id }).from(schema.intakeAccessEvents)
    .where(and(eq(schema.intakeAccessEvents.invitationId, invitationId), eq(schema.intakeAccessEvents.type, type), gte(schema.intakeAccessEvents.occurredAt, since))).orderBy(desc(schema.intakeAccessEvents.occurredAt)).limit(1);
  return !!r;
}

export const isActive = (lastSeenAt: Date, now = new Date()) => now.getTime() - lastSeenAt.getTime() < ACTIVE_WINDOW_MS;

export const fmtDuration = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};

