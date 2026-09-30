import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "../audit";
import { QUEUES, enqueue } from "../jobs";
import { log } from "../logger";
import { purgeRateLimits } from "../rate-limit";
import { getOrgSettings } from "../settings";
import { actionableNow } from "../contracts/routing";
import { expireContract, inviteRecipients, lockContract } from "../contracts/service";
import { queueEmail } from "../messaging/email";
import { storage } from "../storage";
import { contractStakeholders, notifyUsers } from "../notifications";
import { getOrgBranding } from "../settings";
import { finalizeContract } from "../signing/finalize";

const IN_FLIGHT = ["SENT", "DELIVERED", "VIEWED", "PARTIALLY_SIGNED", "AWAITING_SIGNATURE"] as const;
const fmt = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: tz }).format(d);

/** Expire contracts past their deadline. Idempotent: expireContract ignores anything already resolved. */
export async function scanExpiry(now = new Date()) {
  const due = await db.select({ id: schema.contracts.id, orgId: schema.contracts.organisationId }).from(schema.contracts)
    .where(and(inArray(schema.contracts.status, [...IN_FLIGHT]), lt(schema.contracts.expiresAt, now), isNull(schema.contracts.deletedAt))).limit(200);
  for (const c of due) {
    try { await db.transaction((tx) => expireContract(tx, { orgId: c.orgId }, c.id)); } catch (e) { log.error("expire.failed", { contractId: c.id, err: e }); }
  }
  return due.length;
}

/**
 * Automatic reminders. Slots are unique per (recipient, slot) so a re-run, a retry or two workers can never double-send.
 * If several slots are overdue (e.g. the worker was down) only the newest is emailed; the older ones are recorded silently.
 */
export async function scanReminders(now = new Date()) {
  const rows = await db.select().from(schema.contracts).where(and(inArray(schema.contracts.status, [...IN_FLIGHT]), isNull(schema.contracts.deletedAt))).limit(500);
  let sent = 0;
  for (const c of rows) {
    const s = await getOrgSettings(c.organisationId);
    if (!s.reminders.enabled || !c.expiresAt || c.expiresAt <= now) continue;
    await db.transaction(async (tx) => {
      const locked = await lockContract(tx, c.organisationId, c.id);
      const recips = await tx.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, c.id), isNull(schema.recipients.deletedAt)));
      for (const r of actionableNow(recips)) {
        const [req] = await tx.select().from(schema.signatureRequests).where(and(eq(schema.signatureRequests.recipientId, r.id), eq(schema.signatureRequests.status, "ACTIVE")));
        if (!req) continue;
        const slots: Array<{ slot: string; dueAt: Date; kind: "AUTO_AFTER" | "AUTO_BEFORE_EXPIRY"; days?: number }> = [
          ...s.reminders.afterHours.map((h) => ({ slot: `after:${h}h:${req.id}`, dueAt: new Date(req.createdAt.getTime() + h * 3600_000), kind: "AUTO_AFTER" as const })),
          ...s.reminders.beforeExpiryDays.map((d) => ({ slot: `before:${d}d:${req.id}`, dueAt: new Date(locked.expiresAt!.getTime() - d * 86400_000), kind: "AUTO_BEFORE_EXPIRY" as const, days: d })),
        ].filter((x) => x.dueAt <= now && x.dueAt < locked.expiresAt!).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
        if (!slots.length) continue;
        const fresh: typeof slots = [];
        for (const sl of slots) {
          const ins = await tx.insert(schema.reminders).values({ organisationId: c.organisationId, contractId: c.id, recipientId: r.id, kind: sl.kind, slot: sl.slot }).onConflictDoNothing().returning({ id: schema.reminders.id });
          if (ins.length) fresh.push(sl);
        }
        const latest = fresh.at(-1);
        if (!latest) continue;
        if (latest.kind === "AUTO_BEFORE_EXPIRY") {
          const brand = await getOrgBranding(c.organisationId);
          await queueEmail(tx, { orgId: c.organisationId, template: "almost_expired", toEmail: r.email, contractId: c.id, recipientId: r.id, signatureRequestId: req.id, dedupeKey: `almost_expired:${latest.slot}`,
            vars: { recipient_name: r.name, contract_name: c.name, contract_reference: c.reference, expiry_date: fmt(locked.expiresAt!, s.general.timezone), days_left: String(latest.days ?? ""), organisation_name: brand.orgName, sender_name: "" } });
          await audit(tx, { organisationId: c.organisationId, contractId: c.id, recipientId: r.id, eventType: "reminder.sent", metadata: { slot: latest.slot, kind: "expiry" } });
        } else {
          await inviteRecipients(tx, locked, [r], locked.createdBy, "reminder", Number(latest.slot.split(":")[1]!.replace("h", "")));
        }
        sent++;
      }
    });
  }
  return sent;
}

/** Re-enqueue work whose job was lost (crash between commit and enqueue is impossible thanks to the tx outbox, but workers can be wiped). */
export async function sweepOutbox() {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  // A worker that died mid-send leaves SENDING behind; release it so the next attempt can claim it (at-least-once in that crash window).
  await db.update(schema.emailMessages).set({ status: "QUEUED", sendingAt: null }).where(and(eq(schema.emailMessages.status, "SENDING"), lt(schema.emailMessages.sendingAt, new Date(Date.now() - 5 * 60_000))));
  const emails = await db.select({ id: schema.emailMessages.id }).from(schema.emailMessages).where(and(eq(schema.emailMessages.status, "QUEUED"), lt(schema.emailMessages.createdAt, cutoff))).limit(200);
  for (const m of emails) await enqueue(null, QUEUES.email, { messageId: m.id }, { singletonKey: m.id });
  const sms = await db.select({ id: schema.smsMessages.id }).from(schema.smsMessages).where(and(eq(schema.smsMessages.status, "QUEUED"), lt(schema.smsMessages.createdAt, cutoff))).limit(200);
  for (const m of sms) await enqueue(null, QUEUES.sms, { messageId: m.id }, { singletonKey: m.id });
  const hooks = await db.select({ id: schema.webhookDeliveries.id }).from(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.status, "PENDING"), eq(schema.webhookDeliveries.attempts, 0), lt(schema.webhookDeliveries.createdAt, cutoff))).limit(200);
  for (const h of hooks) await enqueue(null, QUEUES.webhook, { deliveryId: h.id }, { singletonKey: h.id });
  const stuck = await db.execute<{ id: string }>(sql`
    select c.id from contracts c where c.status in ('SENT','DELIVERED','VIEWED','PARTIALLY_SIGNED','AWAITING_SIGNATURE') and c.final_version_id is null and c.deleted_at is null
      and exists (select 1 from recipients r where r.contract_id = c.id and r.deleted_at is null and r.role in ('SIGNER','WITNESS','APPROVER'))
      and not exists (select 1 from recipients r where r.contract_id = c.id and r.deleted_at is null and r.role in ('SIGNER','WITNESS','APPROVER') and r.required and r.status <> 'COMPLETED')
      and c.updated_at < ${cutoff} limit 50`);
  for (const c of stuck.rows) await enqueue(null, QUEUES.finalize, { contractId: c.id }, { singletonKey: `finalize:${c.id}` });
  await purgeRateLimits();
  return { emails: emails.length, sms: sms.length, hooks: hooks.length, finalize: stuck.rows.length };
}

const YEARS: Record<string, number> = { "1y": 365, "3y": 1095, "5y": 1825, "7y": 2555 };
const retentionDays = (mode: string, custom: number) => (mode === "never" ? null : mode === "custom" ? custom : YEARS[mode] ?? null);

/**
 * Retention. Nothing is deleted unless the organisation opted in (`autoDelete`) and set a period.
 * Documents: bytes are purged but hashes/audit/certificate rows remain. Audit: whole contract chains only, after the audit period.
 * Before either, owners get a warning notification once per contract.
 */
export async function scanRetention(now = new Date()) {
  const orgs = await db.select({ id: schema.organisations.id }).from(schema.organisations).where(isNull(schema.organisations.deletedAt));
  const stats = { warned: 0, documentsPurged: 0, auditPurged: 0 };
  for (const o of orgs) {
    const s = await getOrgSettings(o.id);
    const docDays = retentionDays(s.retention.documents, s.retention.documentsCustomDays);
    const auditDays = retentionDays(s.retention.audit, s.retention.auditCustomDays);
    const done = ["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED", "VOIDED", "ARCHIVED"] as const;
    if (docDays) {
      const cutoff = new Date(now.getTime() - docDays * 86400_000);
      const warnCutoff = new Date(cutoff.getTime() + s.retention.warnDays * 86400_000);
      const candidates = await db.select().from(schema.contracts).where(and(eq(schema.contracts.organisationId, o.id), inArray(schema.contracts.status, [...done]), isNull(schema.contracts.documentsPurgedAt), lt(schema.contracts.updatedAt, warnCutoff))).limit(200);
      for (const c of candidates) {
        if (c.updatedAt < cutoff && s.retention.autoDelete) {
          await db.transaction(async (tx) => {
            const vers = await tx.select({ obj: schema.contractVersions.storageObjectId }).from(schema.contractVersions).where(eq(schema.contractVersions.contractId, c.id));
            const certs = await tx.select({ obj: schema.completionCertificates.storageObjectId }).from(schema.completionCertificates).where(eq(schema.completionCertificates.contractId, c.id));
            const ids = [...vers.map((v) => v.obj), ...certs.map((v) => v.obj)];
            const objs = ids.length ? await tx.select().from(schema.storageObjects).where(and(inArray(schema.storageObjects.id, ids), isNull(schema.storageObjects.purgedAt))) : [];
            for (const ob of objs) { await storage().delete(ob.key); await tx.update(schema.storageObjects).set({ purgedAt: now }).where(eq(schema.storageObjects.id, ob.id)); }
            await tx.update(schema.contracts).set({ documentsPurgedAt: now }).where(eq(schema.contracts.id, c.id));
            await audit(tx, { organisationId: o.id, contractId: c.id, eventType: "retention.documents_purged", metadata: { policy: s.retention.documents, objects: objs.length } });
          });
          stats.documentsPurged++;
        } else {
          const [w] = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.contractId, c.id), eq(schema.notifications.type, "retention.warning"))).limit(1);
          if (!w) {
            await db.transaction(async (tx) => {
              const owners = await tx.select({ userId: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.organisationId, o.id), inArray(schema.memberships.roleKey, ["ORG_OWNER", "ADMIN"])));
              await notifyUsers(tx, o.id, owners.map((x) => x.userId), "retention.warning", c.id, { contractName: c.name, reference: c.reference, purgeOn: new Date(c.updatedAt.getTime() + docDays * 86400_000).toISOString(), autoDelete: s.retention.autoDelete });
              await audit(tx, { organisationId: o.id, contractId: c.id, eventType: "retention.warning", metadata: { policy: s.retention.documents } });
            });
            stats.warned++;
          }
        }
      }
    }
    if (auditDays && s.retention.autoDelete) {
      const cutoff = new Date(now.getTime() - auditDays * 86400_000);
      const purged = await db.select({ id: schema.contracts.id }).from(schema.contracts).where(and(eq(schema.contracts.organisationId, o.id), lt(schema.contracts.documentsPurgedAt, cutoff))).limit(50);
      for (const c of purged) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('esign.audit_purge', 'on', true)`);
          const r = await tx.execute(sql`delete from audit_events where contract_id = ${c.id} and organisation_id = ${o.id}`);
          await audit(tx, { organisationId: o.id, eventType: "retention.audit_purged", metadata: { contractId: c.id, events: r.rowCount ?? 0, policy: s.retention.audit } });
        });
        stats.auditPurged++;
      }
    }
  }
  return stats;
}

export { finalizeContract, asc, contractStakeholders };
