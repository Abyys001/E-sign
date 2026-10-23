import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "../errors";
import { IsoDate, isLive, type Mode } from "./core";
import { organiserView } from "./entities";
import { UNRECONCILED } from "./reports";

const bt = schema.stripeBalanceTransactions;
const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const count = async (table: PgTable, where: SQL | undefined) => (await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where))[0]?.n ?? 0;

export const TxFilter = z.object({
  q: z.string().trim().max(120).optional(), kind: z.string().max(30).optional(), status: z.string().max(30).optional(), unreconciled: z.coerce.boolean().optional(),
  eventId: z.string().uuid().optional(), organiserId: z.string().uuid().optional(), payoutId: z.string().max(60).optional(), from: IsoDate.optional(), to: IsoDate.optional(),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).optional(),
});
export type TxFilter = z.infer<typeof TxFilter>;

function txOrder(sort: TxFilter["sort"]) {
  if (sort === "date_asc") return [asc(bt.stripeCreatedAt)];
  if (sort === "amount_desc") return [desc(bt.amount), desc(bt.stripeCreatedAt)];
  if (sort === "amount_asc") return [asc(bt.amount), desc(bt.stripeCreatedAt)];
  return [desc(bt.stripeCreatedAt)];
}

function txWhere(orgId: string, mode: Mode, f: TxFilter) {
  return and(
    eq(bt.organisationId, orgId), eq(bt.livemode, isLive(mode)),
    f.kind ? eq(bt.kind, f.kind) : undefined,
    f.status ? eq(bt.reconciliationStatus, f.status) : undefined,
    f.unreconciled ? inArray(bt.reconciliationStatus, [...UNRECONCILED]) : undefined,
    f.eventId ? eq(bt.eventId, f.eventId) : undefined, f.organiserId ? eq(bt.organiserId, f.organiserId) : undefined, f.payoutId ? eq(bt.payoutId, f.payoutId) : undefined,
    f.from ? gte(bt.stripeCreatedAt, new Date(`${f.from}T00:00:00Z`)) : undefined, f.to ? lte(bt.stripeCreatedAt, new Date(`${f.to}T23:59:59.999Z`)) : undefined,
    f.q ? or(eq(bt.balanceTransactionId, f.q), eq(bt.sourceId, f.q), eq(bt.chargeId, f.q), ilike(bt.description, like(f.q)), ilike(bt.eventCode, like(f.q))) : undefined,
  );
}

export async function listTransactions(orgId: string, mode: Mode, f: TxFilter, page: { limit: number; offset: number }, withTotal = true) {
  const where = txWhere(orgId, mode, f);
  const [rows, total] = await Promise.all([
    db.select({ t: bt, eventName: schema.acctEvents.name, organiserName: schema.acctOrganisers.name, customerName: schema.stripeCharges.customerName })
      .from(bt).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, bt.eventId)).leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, bt.organiserId))
      .leftJoin(schema.stripeCharges, and(eq(schema.stripeCharges.stripeAccountRef, bt.stripeAccountRef), eq(schema.stripeCharges.chargeId, bt.chargeId)))
      .where(where).orderBy(...txOrder(f.sort), desc(bt.id)).limit(page.limit).offset(page.offset),
    withTotal ? count(bt, where) : Promise.resolve(0),
  ]);
  return { items: rows.map((r) => ({ ...r.t, eventName: r.eventName, organiserName: r.organiserName, customerName: r.customerName })), total };
}

export async function transactionDetail(orgId: string, id: string) {
  const [row] = await db.select().from(bt).where(and(eq(bt.id, id), eq(bt.organisationId, orgId)));
  if (!row) throw new AppError("not_found", "Transaction not found");
  const [charge] = row.chargeId ? await db.select().from(schema.stripeCharges).where(and(eq(schema.stripeCharges.stripeAccountRef, row.stripeAccountRef), eq(schema.stripeCharges.chargeId, row.chargeId))) : [];
  const [event] = row.eventId ? await db.select().from(schema.acctEvents).where(eq(schema.acctEvents.id, row.eventId)) : [];
  const [organiser] = row.organiserId ? await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.id, row.organiserId)) : [];
  const [agreement] = row.agreementId ? await db.select().from(schema.acctAgreements).where(eq(schema.acctAgreements.id, row.agreementId)) : [];
  const related = row.chargeId ? await db.select().from(bt).where(and(eq(bt.stripeAccountRef, row.stripeAccountRef), eq(bt.chargeId, row.chargeId))).orderBy(asc(bt.stripeCreatedAt)) : [row];
  const refunds = row.chargeId ? await db.select().from(schema.stripeRefunds).where(and(eq(schema.stripeRefunds.stripeAccountRef, row.stripeAccountRef), eq(schema.stripeRefunds.chargeId, row.chargeId))) : [];
  const disputes = row.chargeId ? await db.select().from(schema.stripeDisputes).where(and(eq(schema.stripeDisputes.stripeAccountRef, row.stripeAccountRef), eq(schema.stripeDisputes.chargeId, row.chargeId))) : [];
  const entries = await db.select().from(schema.acctJournalEntries).where(and(eq(schema.acctJournalEntries.organisationId, orgId), eq(schema.acctJournalEntries.stripeBalanceTransactionId, row.balanceTransactionId), eq(schema.acctJournalEntries.stripeAccountRef, row.stripeAccountRef))).orderBy(asc(schema.acctJournalEntries.seq));
  const lines = entries.length ? await db.select({ l: schema.acctJournalLines, code: schema.acctAccounts.code, name: schema.acctAccounts.name }).from(schema.acctJournalLines).innerJoin(schema.acctAccounts, eq(schema.acctAccounts.id, schema.acctJournalLines.accountId)).where(inArray(schema.acctJournalLines.entryId, entries.map((e) => e.id))).orderBy(asc(schema.acctJournalLines.id)) : [];
  const history = await db.select({ h: schema.acctMatchHistory, userName: schema.users.name }).from(schema.acctMatchHistory).leftJoin(schema.users, eq(schema.users.id, schema.acctMatchHistory.userId)).where(eq(schema.acctMatchHistory.balanceTransactionRef, row.id)).orderBy(desc(schema.acctMatchHistory.createdAt));
  const [payout] = row.payoutId ? await db.select().from(schema.stripePayouts).where(and(eq(schema.stripePayouts.stripeAccountRef, row.stripeAccountRef), eq(schema.stripePayouts.payoutId, row.payoutId))) : [];
  // Gross/refund/fee/net for the whole sale (the sale plus every refund/dispute that belongs to it).
  const sale = related.reduce((s, r) => ({ gross: s.gross + (r.kind === "SALE" ? r.amount : 0), refunded: s.refunded + (r.kind === "REFUND" ? -r.amount : 0), disputed: s.disputed + (r.kind.startsWith("DISPUTE") ? -r.amount : 0), fee: s.fee + r.fee, net: s.net + r.net, commission: s.commission + (r.commissionAmount ?? 0), organiser: s.organiser + (r.organiserAmount ?? 0) }), { gross: 0, refunded: 0, disputed: 0, fee: 0, net: 0, commission: 0, organiser: 0 });
  return {
    transaction: row, charge: charge ?? null, event: event ?? null, organiser: organiser ? organiserView(organiser) : null, agreement: agreement ?? null, payout: payout ?? null,
    related, refunds, disputes, sale: row.chargeId ? sale : null,
    entries: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.l.entryId === e.id).map((l) => ({ ...l.l, accountCode: l.code, accountName: l.name })) })),
    history: history.map((h) => ({ ...h.h, userName: h.userName })),
  };
}

export async function listPayouts(orgId: string, mode: Mode, page: { limit: number; offset: number }, f: { status?: string; from?: string; to?: string } = {}) {
  const p = schema.stripePayouts;
  const where = and(eq(p.organisationId, orgId), eq(p.livemode, isLive(mode)), f.status ? eq(p.status, f.status) : undefined, f.from ? gte(p.stripeCreatedAt, new Date(`${f.from}T00:00:00Z`)) : undefined, f.to ? lte(p.stripeCreatedAt, new Date(`${f.to}T23:59:59.999Z`)) : undefined);
  const [items, total] = await Promise.all([
    db.select({ p, accountId: schema.stripeAccounts.stripeAccountId,
      linked: sql<Array<{ id: string; organiser: string; eventCode: string | null; amount: number; currency: string }> | null>`(select json_agg(json_build_object('id', op.id, 'organiser', o.name, 'eventCode', ev.code, 'amount', op.amount, 'currency', op.currency))
        from acct_organiser_payments op join acct_organisers o on o.id = op.organiser_id left join acct_events ev on ev.id = op.event_id
        where op.organisation_id = ${p.organisationId} and op.livemode = ${p.livemode} and op.bank_reference = ${p.payoutId} and op.status <> 'VOIDED')` }).from(p).innerJoin(schema.stripeAccounts, eq(schema.stripeAccounts.id, p.stripeAccountRef)).where(where).orderBy(desc(p.stripeCreatedAt)).limit(page.limit).offset(page.offset),
    count(p, where),
  ]);
  return { items: items.map((r) => ({ ...r.p, stripeAccountId: r.accountId, linkedPayments: r.linked ?? [] })), total };
}

export async function listDisputes(orgId: string, mode: Mode, page: { limit: number; offset: number }) {
  const d = schema.stripeDisputes;
  const where = and(eq(d.organisationId, orgId), eq(d.livemode, isLive(mode)));
  const [items, total] = await Promise.all([
    db.select({ d, eventName: schema.acctEvents.name, eventCode: schema.acctEvents.code, organiserName: schema.acctOrganisers.name }).from(d).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, d.eventId)).leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, d.organiserId)).where(where).orderBy(desc(d.stripeCreatedAt)).limit(page.limit).offset(page.offset),
    count(d, where),
  ]);
  return { items: items.map((r) => ({ ...r.d, eventName: r.eventName, eventCode: r.eventCode, organiserName: r.organiserName })), total };
}

export async function listWebhookEvents(orgId: string, mode: Mode, page: { limit: number; offset: number }) {
  const e = schema.stripeEvents;
  const where = and(eq(e.organisationId, orgId), eq(e.livemode, isLive(mode)));
  const [items, total] = await Promise.all([db.select().from(e).where(where).orderBy(desc(e.receivedAt)).limit(page.limit).offset(page.offset), count(e, where)]);
  return { items, total };
}

export async function listSyncErrors(orgId: string, mode: Mode, limit = 100) {
  const e = schema.acctSyncErrors;
  return db.select().from(e).where(and(eq(e.organisationId, orgId), eq(e.livemode, isLive(mode)), isNull(e.resolvedAt))).orderBy(desc(e.createdAt)).limit(limit);
}

export async function listOrganisers(orgId: string, f: { q?: string; active?: boolean }, page: { limit: number; offset: number }) {
  const o = schema.acctOrganisers;
  const where = and(eq(o.organisationId, orgId), f.active === undefined ? undefined : eq(o.active, f.active), f.q ? or(ilike(o.name, like(f.q)), ilike(o.companyName, like(f.q)), ilike(o.email, like(f.q)), ilike(o.internalRef, like(f.q))) : undefined);
  const [items, total] = await Promise.all([
    db.select({ o, events: sql<number>`(select count(*)::int from acct_events ev where ev.organiser_id = "acct_organisers"."id")` }).from(o).where(where).orderBy(asc(o.name)).limit(page.limit).offset(page.offset),
    count(o, where),
  ]);
  return { items: items.map((r) => ({ ...organiserView(r.o), eventCount: r.events })), total };
}

export async function listEvents(orgId: string, f: { q?: string; organiserId?: string; status?: string }, page: { limit: number; offset: number }) {
  const e = schema.acctEvents;
  const where = and(eq(e.organisationId, orgId), f.organiserId ? eq(e.organiserId, f.organiserId) : undefined, f.status ? eq(e.status, f.status) : undefined, f.q ? or(ilike(e.name, like(f.q)), ilike(e.code, like(f.q))) : undefined);
  const [items, total] = await Promise.all([
    db.select({ e, organiserName: schema.acctOrganisers.name, agreement: schema.acctAgreements }).from(e).leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, e.organiserId)).leftJoin(schema.acctAgreements, eq(schema.acctAgreements.id, e.currentAgreementId)).where(where).orderBy(desc(e.startsOn), asc(e.name)).limit(page.limit).offset(page.offset),
    count(e, where),
  ]);
  return { items: items.map((r) => ({ ...r.e, organiserName: r.organiserName, agreement: r.agreement })), total };
}

export async function listPayments(orgId: string, mode: Mode, f: { organiserId?: string; eventId?: string; status?: string }, page: { limit: number; offset: number }) {
  const p = schema.acctOrganiserPayments;
  const where = and(eq(p.organisationId, orgId), eq(p.livemode, isLive(mode)), f.organiserId ? eq(p.organiserId, f.organiserId) : undefined, f.eventId ? eq(p.eventId, f.eventId) : undefined, f.status ? eq(p.status, f.status) : undefined);
  const [items, total] = await Promise.all([
    db.select({ p, organiserName: schema.acctOrganisers.name, eventName: schema.acctEvents.name, eventCode: schema.acctEvents.code, createdByName: schema.users.name }).from(p)
      .innerJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, p.organiserId)).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, p.eventId)).leftJoin(schema.users, eq(schema.users.id, p.createdBy))
      .where(where).orderBy(desc(p.paymentDate), desc(p.createdAt)).limit(page.limit).offset(page.offset),
    count(p, where),
  ]);
  const payees = await paymentPayees(orgId, items.map((r) => r.p));
  return { items: items.map((r) => ({ ...r.p, organiserName: r.organiserName, eventName: r.eventName, eventCode: r.eventCode, createdByName: r.createdByName, payee: payees.get(r.p.id) ?? null })), total };
}

/** Who actually received each payment: the Wise recipient, from the linked Wise row or the "Wise #123" reference. */
async function paymentPayees(orgId: string, ps: Array<{ id: string; bankReference: string | null; notes: string | null }>) {
  const out = new Map<string, string>();
  if (!ps.length) return out;
  const w = schema.acctWiseTransactions;
  const tid = (r: string | null) => r?.match(/wise\s*#?\s*(\d{5,15})/i)?.[1];
  const refIds = [...new Set(ps.map((p) => tid(p.bankReference)).filter(Boolean).map((x) => `TRANSFER-${x}`))];
  const rows = await db.select({ wiseId: w.wiseId, paymentId: w.organiserPaymentId, counterparty: w.counterparty }).from(w)
    .where(and(eq(w.organisationId, orgId), or(inArray(w.organiserPaymentId, ps.map((p) => p.id)), refIds.length ? inArray(w.wiseId, refIds) : undefined)));
  for (const p of ps) {
    const r = rows.find((x) => x.paymentId === p.id) ?? rows.find((x) => x.wiseId === `TRANSFER-${tid(p.bankReference)}`);
    const fromNote = p.notes?.match(/\bto ([A-Z][^(),.]*?)(?: \(|,)/)?.[1]?.trim(); // until Wise syncs: "… to Adam Holmberg (SEB …"
    if (r?.counterparty || fromNote) out.set(p.id, (r?.counterparty || fromNote)!);
  }
  return out;
}

export const LedgerFilter = z.object({ entryType: z.string().max(40).optional(), eventId: z.string().uuid().optional(), organiserId: z.string().uuid().optional(), accountId: z.string().uuid().optional(), from: IsoDate.optional(), to: IsoDate.optional(), q: z.string().trim().max(120).optional() });
export async function listEntries(orgId: string, mode: Mode, f: z.infer<typeof LedgerFilter>, page: { limit: number; offset: number }) {
  const e = schema.acctJournalEntries;
  const where = and(eq(e.organisationId, orgId), eq(e.livemode, isLive(mode)), f.entryType ? eq(e.entryType, f.entryType) : undefined, f.eventId ? eq(e.eventId, f.eventId) : undefined, f.organiserId ? eq(e.organiserId, f.organiserId) : undefined,
    f.from ? gte(e.entryDate, f.from) : undefined, f.to ? lte(e.entryDate, f.to) : undefined, f.q ? or(ilike(e.description, like(f.q)), eq(e.reference, f.q), eq(e.stripeBalanceTransactionId, f.q)) : undefined,
    f.accountId ? sql`exists (select 1 from acct_journal_lines l where l.entry_id = ${e.id} and l.account_id = ${f.accountId})` : undefined);
  const [items, total] = await Promise.all([
    db.select({ e, userName: schema.users.name }).from(e).leftJoin(schema.users, eq(schema.users.id, e.createdBy)).where(where).orderBy(desc(e.entryDate), desc(e.seq)).limit(page.limit).offset(page.offset),
    count(e, where),
  ]);
  const ids = items.map((r) => r.e.id);
  const lines = ids.length ? await db.select({ l: schema.acctJournalLines, code: schema.acctAccounts.code, name: schema.acctAccounts.name }).from(schema.acctJournalLines).innerJoin(schema.acctAccounts, eq(schema.acctAccounts.id, schema.acctJournalLines.accountId)).where(inArray(schema.acctJournalLines.entryId, ids)).orderBy(asc(schema.acctJournalLines.id)) : [];
  return { items: items.map((r) => ({ ...r.e, createdByName: r.userName, lines: lines.filter((l) => l.l.entryId === r.e.id).map((l) => ({ ...l.l, accountCode: l.code, accountName: l.name })) })), total };
}

/** "Order (x) for event: Blood In Blood Out Berlin (B41-0091), by …" → "Blood In Blood Out Berlin". */
export function eventNameFromDescription(d: string | null | undefined, code: string): string {
  const i = d ? d.toUpperCase().lastIndexOf(`(${code.toUpperCase()})`) : -1;
  const m = i > 0 ? /for event:\s*(.*)$/i.exec(d!.slice(0, i)) : null;
  return m?.[1]?.trim().replace(/\s+/g, " ").slice(0, 200) ?? "";
}

/** Event codes found in imported Stripe sales that have no event in Bilit yet (both modes), with a suggested name. */
export async function detectedCodes(orgId: string) {
  const r = await db.execute<{ code: string; currency: string; n: number; gross: string; description: string | null; livemode: boolean }>(sql`
    select upper(event_code) as code, currency, count(*)::int as n, sum(amount)::text as gross, max(description) as description, bool_or(livemode) as livemode
    from stripe_balance_transactions where organisation_id = ${orgId} and kind = 'SALE' and match_reason = 'CODE_NOT_FOUND' and event_code is not null
    group by 1, 2 order by 1`);
  return r.rows.map((x) => ({ code: x.code, currency: x.currency, transactions: x.n, gross: Number(x.gross), name: eventNameFromDescription(x.description, x.code), live: x.livemode }));
}
