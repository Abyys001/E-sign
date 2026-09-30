import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "../audit";
import { getOrgSettings } from "../settings";
import { QUEUES, enqueue } from "../jobs";
import { queueEmail } from "../messaging/email";
import { getOrgBranding } from "../settings";
import { FormSettings } from "./schema";

const HOUR = 3_600_000;

/**
 * Intake reminders. One row per (invitation, slot) is the idempotency guard: re-runs, retries and parallel workers cannot resend.
 * If several slots are overdue only the newest one is emailed; earlier ones are recorded silently.
 * Paged by id so no invitation is ever skipped by a fixed batch limit.
 */
export async function scanIntakeReminders(now = new Date()) {
  let cursor = "00000000-0000-0000-0000-000000000000";
  let sent = 0;
  for (;;) {
    const rows = await db.select({ inv: schema.intakeInvitations, ver: schema.intakeFormVersions, form: { title: schema.intakeForms.title } }).from(schema.intakeInvitations)
      .innerJoin(schema.intakeFormVersions, eq(schema.intakeFormVersions.id, schema.intakeInvitations.formVersionId))
      .innerJoin(schema.intakeForms, eq(schema.intakeForms.id, schema.intakeInvitations.formId))
      .innerJoin(schema.intakeSubmissions, eq(schema.intakeSubmissions.invitationId, schema.intakeInvitations.id))
      .where(and(gt(schema.intakeInvitations.id, cursor), eq(schema.intakeInvitations.status, "SENT"), gt(schema.intakeInvitations.expiresAt, now), ne(schema.intakeSubmissions.status, "SUBMITTED")))
      .orderBy(asc(schema.intakeInvitations.id)).limit(200);
    if (!rows.length) break;
    for (const { inv, ver, form } of rows) {
      const cfg = FormSettings.parse(ver.settings).reminders;
      const due: Array<{ slot: string; at: number }> = [];
      const base = (inv.sentAt ?? inv.createdAt).getTime();
      for (const h of cfg.afterHours) if (base + h * HOUR <= now.getTime()) due.push({ slot: `after_h:${h}`, at: base + h * HOUR });
      for (const h of cfg.beforeExpiryHours) if (inv.expiresAt.getTime() - h * HOUR <= now.getTime()) due.push({ slot: `before_h:${h}`, at: inv.expiresAt.getTime() - h * HOUR });
      if (!due.length) continue;
      due.sort((x, y) => x.at - y.at);
      const newest = due[due.length - 1]!;
      await db.transaction(async (tx) => {
        for (const d of due) {
          const ins = await tx.insert(schema.intakeReminders).values({ organisationId: inv.organisationId, invitationId: inv.id, slot: d.slot }).onConflictDoNothing().returning({ id: schema.intakeReminders.id });
          if (!ins.length || d.slot !== newest.slot) continue;
          const brand = await getOrgBranding(inv.organisationId);
          const mid = await queueEmail(tx, {
            orgId: inv.organisationId, template: "intake_reminder", toEmail: inv.recipientEmail, intakeInvitationId: inv.id, locale: FormSettings.parse(ver.settings).language, dedupeKey: `intake_reminder:${inv.id}:${d.slot}`,
            vars: { recipient_name: inv.recipientName, form_title: form.title, organisation_name: brand.orgName, expiry_date: new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(inv.expiresAt) },
          });
          await tx.update(schema.intakeReminders).set({ emailMessageId: mid }).where(eq(schema.intakeReminders.id, ins[0]!.id));
          await audit(tx, { organisationId: inv.organisationId, eventType: "intake.reminder.sent", metadata: { invitationId: inv.id, slot: d.slot } });
          sent++;
        }
      });
    }
    cursor = rows[rows.length - 1]!.inv.id;
  }
  return sent;
}

/** Re-enqueue submissions stuck queued/running (worker crash) and record expiry of unopened-or-unfinished invitations. */
export async function sweepIntake(now = new Date()) {
  const stuck = await db.select({ id: schema.intakeSubmissions.id, rev: schema.intakeSubmissions.submissionRev }).from(schema.intakeSubmissions)
    .where(and(inArray(schema.intakeSubmissions.generationStatus, ["QUEUED", "RUNNING"]), lt(schema.intakeSubmissions.updatedAt, new Date(now.getTime() - 5 * 60_000)))).limit(100);
  for (const s of stuck) await enqueue(null, QUEUES.intakeProcess, { submissionId: s.id, submissionRev: s.rev }, { singletonKey: `${s.id}:${s.rev}:sweep:${Math.floor(now.getTime() / 300_000)}` });
  return stuck.length;
}

/** Audit `intake.form.expired` once per invitation that lapsed without submission. */
export async function auditExpiredInvitations(now = new Date()) {
  const rows = await db.select({ inv: schema.intakeInvitations }).from(schema.intakeInvitations)
    .innerJoin(schema.intakeSubmissions, eq(schema.intakeSubmissions.invitationId, schema.intakeInvitations.id))
    .where(and(eq(schema.intakeInvitations.status, "SENT"), lt(schema.intakeInvitations.expiresAt, now), ne(schema.intakeSubmissions.status, "SUBMITTED"),
      sql`not exists (select 1 from audit_events a where a.organisation_id = ${schema.intakeInvitations.organisationId} and a.contract_id is null and a.event_type = 'intake.form.expired' and a.metadata->>'invitationId' = ${schema.intakeInvitations.id}::text)`)).limit(200);
  for (const { inv } of rows) await db.transaction((tx) => audit(tx, { organisationId: inv.organisationId, eventType: "intake.form.expired", metadata: { invitationId: inv.id, formId: inv.formId } }));
  return rows.length;
}


/** Truncate `a.b.c.d` -> `a.b.c.0` and IPv6 to its /48. Coarse enough to stop identifying a household, kept for abuse triage. */
export const anonymiseIp = sql`case
  when ip ~ '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' then regexp_replace(ip, '\\.[0-9]+$', '.0')
  when ip like '%:%' then split_part(ip, ':', 1) || ':' || split_part(ip, ':', 2) || ':' || split_part(ip, ':', 3) || '::'
  else null end`;

/** Per-organisation privacy retention for access telemetry. Answers, audit and evidence are governed by their own settings. */
export async function scanIntakeRetention(now = new Date()) {
  const orgs = await db.select({ id: schema.organisations.id }).from(schema.organisations).where(isNull(schema.organisations.deletedAt));
  const total = { anonymisedSessions: 0, anonymisedEvents: 0, deletedSessions: 0, deletedEvents: 0 };
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  for (const o of orgs) {
    const { privacy } = await getOrgSettings(o.id);
    const stats = { anonymisedSessions: 0, anonymisedEvents: 0, deletedSessions: 0, deletedEvents: 0 };
    if (privacy.ipAnonymiseDays) {
      const cut = ago(privacy.ipAnonymiseDays);
      const s = await db.update(schema.intakeAccessSessions).set({ ip: anonymiseIp }).where(and(eq(schema.intakeAccessSessions.organisationId, o.id), lt(schema.intakeAccessSessions.lastSeenAt, cut), sql`ip is not null and ip <> ${anonymiseIp}`)).returning({ id: schema.intakeAccessSessions.id });
      const e = await db.update(schema.intakeAccessEvents).set({ ip: anonymiseIp }).where(and(eq(schema.intakeAccessEvents.organisationId, o.id), lt(schema.intakeAccessEvents.occurredAt, cut), sql`ip is not null and ip <> ${anonymiseIp}`)).returning({ id: schema.intakeAccessEvents.id });
      stats.anonymisedSessions += s.length; stats.anonymisedEvents += e.length;
    }
    if (privacy.telemetryDays) {
      const cut = ago(privacy.telemetryDays);
      const e = await db.delete(schema.intakeAccessEvents).where(and(eq(schema.intakeAccessEvents.organisationId, o.id), lt(schema.intakeAccessEvents.occurredAt, cut))).returning({ id: schema.intakeAccessEvents.id });
      const old = and(eq(schema.intakeAccessSessions.organisationId, o.id), lt(schema.intakeAccessSessions.lastSeenAt, cut));
      await db.delete(schema.intakeOtps).where(sql`${schema.intakeOtps.sessionId} in (select id from intake_access_sessions where organisation_id = ${o.id} and last_seen_at < ${cut})`);
      const s = await db.delete(schema.intakeAccessSessions).where(old).returning({ id: schema.intakeAccessSessions.id });
      stats.deletedEvents += e.length; stats.deletedSessions += s.length;
    }
    if (Object.values(stats).some(Boolean)) await db.transaction((tx) => audit(tx, { organisationId: o.id, eventType: "retention.intake_telemetry", metadata: { ...stats } }));
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += stats[k];
  }
  return total;
}
