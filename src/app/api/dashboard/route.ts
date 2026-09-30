import { sql } from "drizzle-orm";
import { db } from "@/db";
import { authed } from "@/server/http";

/** Every number is a real aggregate over this organisation's rows. */
export const GET = authed("contracts.view", async ({ auth }) => {
  const org = auth.organisationId;
  const [counts, perf, trend, email, sms, reminders, recent, attention] = await Promise.all([
    db.execute<{ status: string; n: number }>(sql`select status, count(*)::int n from contracts where organisation_id = ${org} and deleted_at is null group by status`),
    db.execute<{ sent: number; signatures: number; avg_hours: number | null }>(sql`select
      (select count(*)::int from contracts where organisation_id = ${org} and sent_at is not null and deleted_at is null) sent,
      (select count(*)::int from signatures where organisation_id = ${org}) signatures,
      (select round(avg(extract(epoch from (completed_at - sent_at)) / 3600)::numeric, 1)::float from contracts where organisation_id = ${org} and completed_at is not null and sent_at is not null) avg_hours`),
    db.execute<{ day: string; sent: number; completed: number }>(sql`select to_char(d, 'YYYY-MM-DD') as day,
      (select count(*)::int from contracts where organisation_id = ${org} and sent_at::date = d) sent,
      (select count(*)::int from contracts where organisation_id = ${org} and completed_at::date = d) completed
      from generate_series(current_date - 29, current_date, interval '1 day') d order by d`),
    db.execute<{ status: string; n: number }>(sql`select status, count(*)::int n from email_messages where organisation_id = ${org} and created_at > now() - interval '30 days' group by status`),
    db.execute<{ status: string; n: number }>(sql`select status, count(*)::int n from sms_messages where organisation_id = ${org} and created_at > now() - interval '30 days' group by status`),
    db.execute<{ n: number }>(sql`select count(*)::int n from reminders where organisation_id = ${org} and sent_at > now() - interval '7 days'`),
    db.execute(sql`select e.event_type as "eventType", e.occurred_at as "occurredAt", e.contract_id as "contractId", c.name as "contractName", c.reference from audit_events e left join contracts c on c.id = e.contract_id
      where e.organisation_id = ${org} and e.contract_id is not null and e.event_type in ('contract.sent','document.viewed','recipient.completed','contract.completed','contract.declined','contract.status.expired','contract.status.cancelled','contract.status.voided')
      order by e.seq desc limit 12`),
    db.execute(sql`select id, name, reference, status, expires_at as "expiresAt", updated_at as "updatedAt" from contracts where organisation_id = ${org} and deleted_at is null and (
      (status in ('SENT','DELIVERED','VIEWED','PARTIALLY_SIGNED','AWAITING_SIGNATURE') and expires_at < now() + interval '3 days') or status = 'DECLINED' and updated_at > now() - interval '14 days')
      order by expires_at nulls last limit 8`),
  ]);
  const by = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  const pick = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const p = perf.rows[0]!;
  return {
    totals: { all: Object.values(by).reduce((a, b) => a + b, 0), draft: (by.DRAFT ?? 0) + (by.READY_TO_SEND ?? 0), sent: p.sent, awaiting: (by.SENT ?? 0) + (by.DELIVERED ?? 0) + (by.VIEWED ?? 0) + (by.PARTIALLY_SIGNED ?? 0) + (by.AWAITING_SIGNATURE ?? 0), completed: by.COMPLETED ?? 0, declined: by.DECLINED ?? 0, expired: by.EXPIRED ?? 0, cancelled: (by.CANCELLED ?? 0) + (by.VOIDED ?? 0), archived: by.ARCHIVED ?? 0 },
    signaturesCompleted: p.signatures, avgCompletionHours: p.avg_hours, trend: trend.rows, email: pick(email.rows), sms: pick(sms.rows), remindersLast7d: reminders.rows[0]?.n ?? 0, recent: recent.rows, attention: attention.rows,
  };
});
