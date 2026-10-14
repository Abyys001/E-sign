import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatMoney } from "@/lib/money";
import { log } from "../logger";
import { acctAudit, accountingEnabled, getAcctSettings, isLive, isPeriodClosed, localDate, type Mode } from "./core";
import { eventFinancials, type EventFinanceRow } from "./finance";
import { postEntry, reverseEntry } from "./ledger";

/**
 * Organiser cashback: Bilit gives an organiser back a % (acct_organisers.cashback_bps) of each FINISHED event's ticket
 * sales after refunds, excluding Bilit's booking fee (= the organiser's share before Stripe fees). It is a Bilit cost
 * (6960 Organiser Cashback) added to what the organiser is owed (2000), so it is paid with the settlement and shows on
 * statements. Kept true like profit shares: target − booked is posted per event × currency, so late refunds, a changed
 * rate or an event re-opened (no longer finished) correct it automatically. Append-only; idempotent.
 */
export const cashbackBase = (e: Pick<EventFinanceRow, "organiserShare">) => Math.max(0, e.organiserShare);
export function cashbackTarget(e: Pick<EventFinanceRow, "organiserShare" | "eventStatus" | "startsOn">, o: { cashbackBps: number; cashbackFrom: string | null }) {
  if (e.eventStatus !== "COMPLETED" || o.cashbackBps <= 0) return 0;
  if (o.cashbackFrom && e.startsOn && e.startsOn < o.cashbackFrom) return 0;
  return Math.round((cashbackBase(e) * o.cashbackBps) / 10_000);
}

async function booked(orgId: string, live: boolean, organiserId: string) {
  const r = await db.execute<{ event_id: string; currency: string; amt: string; n: number }>(sql`
    select l.event_id::text, e.currency, sum(l.debit - l.credit)::text as amt, count(distinct e.id)::int as n
    from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${live} and a.system_key = 'organiser_cashback' and e.source_type = 'organiser_cashback' and e.source_id = ${organiserId} and l.event_id is not null
    group by 1, 2`);
  return new Map(r.rows.map((x) => [`${x.event_id}|${x.currency}`, { amt: Number(x.amt), n: x.n }]));
}

/**
 * Entries booked before 2026-10-14 ~14:20 carried the organiser only on the entry, not on its lines, so organiser-level
 * balances missed them. Reverse those (append-only); the true-up below then re-books them with the organiser on every line.
 */
async function repairUnattributed(orgId: string, live: boolean, organiserId: string, timezone: string, userId: string | null) {
  const bad = await db.execute<{ id: string }>(sql`
    select distinct e.id from acct_journal_entries e join acct_journal_lines l on l.entry_id = e.id
    where e.organisation_id = ${orgId} and e.livemode = ${live} and e.source_type = 'organiser_cashback' and e.source_id = ${organiserId}
      and e.status <> 'REVERSED' and e.entry_type <> 'REVERSAL' and l.organiser_id is null`);
  for (const r of bad.rows) {
    try { await db.transaction((tx) => reverseEntry(tx, { orgId, entryId: r.id, reason: "Re-booked with the organiser on each line", userId, timezone })); }
    catch (err) { log.warn("accounting.cashback_repair_failed", { entry: r.id, error: String(err).slice(0, 300) }); }
  }
}

/** Post the difference between each event's cashback and what is booked, for every organiser that has (or had) a rate. */
export async function syncCashback(orgId: string, mode: Mode, opts: { userId?: string | null; organiserId?: string } = {}) {
  const live = isLive(mode);
  const { timezone } = await getAcctSettings(orgId);
  const today = localDate(new Date(), timezone || "UTC");
  const orgs = await db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.organisationId, orgId), opts.organiserId ? eq(schema.acctOrganisers.id, opts.organiserId) : undefined));
  let posted = 0;
  for (const o of orgs) {
    await repairUnattributed(orgId, live, o.id, timezone || "UTC", opts.userId ?? null);
    const have = await booked(orgId, live, o.id);
    if (o.cashbackBps <= 0 && !have.size) continue;
    for (const e of await eventFinancials(orgId, mode, { organiserId: o.id })) {
      const k = `${e.eventId}|${e.currency}`, was = have.get(k)?.amt ?? 0, seq = have.get(k)?.n ?? 0, target = cashbackTarget(e, o), diff = target - was;
      if (!diff) continue;
      let date = e.startsOn && e.startsOn <= today ? e.startsOn : today;
      if (await isPeriodClosed(db, orgId, date)) date = today;
      // the key carries the number of cashback entries already on the event: the same from→to can recur (re-opened, finished again)
      try {
        await db.transaction(async (tx) => {
          const { created } = await postEntry(tx, {
            orgId, livemode: live, entryType: "ADJUSTMENT", sourceDate: new Date(`${date}T12:00:00Z`), entryDate: date, currency: e.currency,
            description: `${o.cashbackBps / 100}% cashback to ${o.name} — ${e.eventName} (${e.eventCode})${was ? ` adjustment (ticket sales now ${formatMoney(cashbackBase(e), e.currency, "en")})` : ""}`,
            eventId: e.eventId, organiserId: o.id, sourceType: "organiser_cashback", sourceId: o.id, idempotencyKey: `cashback:v2:${o.id}:${e.eventId}:${e.currency}:${seq}:${was}->${target}`, createdBy: opts.userId ?? null, timezone,
            // organiserId on the lines: organiser-level balances (lists, account totals, Financial Overview) aggregate by line
            postings: [{ account: "organiser_cashback", amount: diff, eventId: e.eventId, organiserId: o.id, memo: `Cashback ${o.cashbackBps / 100}%` }, { account: "organiser_payable", amount: -diff, eventId: e.eventId, organiserId: o.id, memo: `Cashback to ${o.name}` }],
          });
          if (created) { posted++; await acctAudit(tx, { orgId, userId: opts.userId ?? null, action: "cashback.accrued", entity: "organiser", entityId: o.id, new: { eventId: e.eventId, currency: e.currency, from: was, to: target, base: cashbackBase(e), bps: o.cashbackBps } }); }
        });
      } catch (err) { log.warn("accounting.cashback_post_failed", { organiser: o.id, event: e.eventId, error: String(err).slice(0, 300) }); }
    }
  }
  return { posted };
}

/** Worker: keep cashback current for every organisation with a cashback rate (or previously booked cashback). */
export async function syncAllCashback() {
  if (!accountingEnabled()) return 0;
  const orgs = await db.selectDistinct({ orgId: schema.acctOrganisers.organisationId }).from(schema.acctOrganisers).where(gt(schema.acctOrganisers.cashbackBps, 0));
  for (const o of orgs) for (const mode of ["live", "test"] as const) { try { await syncCashback(o.orgId, mode); } catch (e) { log.warn("accounting.cashback_sync_failed", { orgId: o.orgId, error: String(e).slice(0, 300) }); } }
  return orgs.length;
}
