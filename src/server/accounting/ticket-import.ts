import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { parseMajor } from "@/lib/money";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { acctAudit, getAcctSettings, isLive, type Mode } from "./core";
import { postEntry } from "./ledger";

/**
 * Ticket-system CSV export for one event (one row per ticket). The checkout added the booking fee on top of the ticket
 * price, and the rate changed over time (e.g. 7 % early, 12–13 % later), so the agreement % cannot reproduce it. The
 * export says, per order, the organiser's ticket price and the booking fee actually charged; Stripe says what was paid.
 * Anything Stripe took beyond the export's "Total User Paid" (add-ons such as Meet & Greet, which the export leaves out of
 * the price columns) is organiser money. Applying an import trues up the event's booked booking fee to the export:
 * Dr organiser share / Cr organiser payable for the difference, one true-up entry per change (idempotent).
 */

type Actor = { orgId: string; userId: string; ctx: RequestContext };

export type TicketRow = { order: string; type: string; price: number; bookingFee: number; facilityFee: number; transactionFee: number; total: number; checkedIn: boolean; addOn: boolean; eventName: string | null };
export type OrderLine = {
  order: string; tickets: number; free: boolean; types: string[]; price: number; fee: number; total: number; addOnTickets: number;
  stripe: number | null; addOnAmount: number; bookedFee: number | null; targetFee: number | null; status: "MATCHED" | "FREE" | "SITE_ONLY" | "AMOUNT_LOW" | "REFUNDED";
  /** other orders paid in the same Stripe payment, folded into this one */ merged?: string[];
};
export type TypeLine = { type: string; tickets: number; paid: number; free: number; price: number; fee: number };
export type ImportSummary = {
  currency: string; rows: number; tickets: number; paidTickets: number; freeTickets: number; checkedIn: number; orders: number; paidOrders: number;
  ticketPrice: number; bookingFees: number; customersPaid: number; addOnTickets: number; addOnAmount: number;
  byType: TypeLine[]; feeRates: Array<{ pct: string; tickets: number }>;
  stripeSales: number; stripeAmount: number; matchedOrders: number;
  siteOnly: Array<{ order: string; total: number }>; stripeOnly: Array<{ order: string | null; amount: number }>; amountLow: Array<{ order: string; site: number; stripe: number }>; refunded: string[];
  bookedFee: number; targetFee: number; correction: number; eventNames: string[];
  /** Tickets the ticket system issued for orders with no successful Stripe payment: left out of every total above. */
  unpaid?: Array<{ order: string; tickets: number; total: number; types: string[] }>;
};

// ---------- CSV ----------
/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF/LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some((x) => x.trim() !== "")) out.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x.trim() !== "")) out.push(row);
  return out;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();

/** Ticket rows from the export. Columns are found by header name, so column order and extra columns do not matter. */
export function parseTicketCsv(text: string, currency: string): TicketRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new AppError("validation_failed", "The file has no ticket rows.", [{ path: "file", message: "Empty file" }]);
  const head = rows[0]!.map(norm);
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n));
  const find = (pred: (h: string) => boolean) => head.findIndex(pred);
  const c = {
    order: col("order id", "order", "order ref", "order reference"),
    type: col("ticket type", "type"),
    price: col("ticket price organizer", "ticket price organiser", "ticket price"),
    booking: col("booking fee"),
    facility: col("facility fee"),
    transaction: col("transaction fee"),
    total: col("total user paid", "total paid", "total"),
    checked: col("checked in"),
    addOn: find((h) => h.includes("meet") || h.includes("add on") || h.includes("addon")),
    event: col("event name", "event"),
  };
  const missing = (["order", "price", "booking"] as const).filter((k) => c[k] < 0);
  if (missing.length) throw new AppError("validation_failed", `Missing column(s): ${missing.map((k) => ({ order: "Order ID", price: "Ticket Price (Organizer)", booking: "Booking Fee" })[k]).join(", ")}.`, [{ path: "file", message: "Not a ticket export" }]);
  const amt = (v: string | undefined, line: number, what: string) => {
    const s = (v ?? "").replace(/[€£$]|[A-Za-z]{3}\s/g, "").trim();
    if (!s) return 0;
    try { return parseMajor(s, currency); } catch { throw new AppError("validation_failed", `Row ${line}: ${what} "${v}" is not an amount.`, [{ path: "file", message: "Bad amount" }]); }
  };
  const yes = (v: string | undefined) => /^(yes|y|true|1)$/i.test((v ?? "").trim());
  return rows.slice(1).map((r, i) => {
    const line = i + 2;
    const order = (r[c.order] ?? "").trim();
    if (!order) throw new AppError("validation_failed", `Row ${line} has no Order ID.`, [{ path: "file", message: "Missing order" }]);
    const price = amt(r[c.price], line, "Ticket price"), bookingFee = amt(r[c.booking], line, "Booking fee");
    const facilityFee = c.facility >= 0 ? amt(r[c.facility], line, "Facility fee") : 0, transactionFee = c.transaction >= 0 ? amt(r[c.transaction], line, "Transaction fee") : 0;
    return { order, type: c.type >= 0 ? (r[c.type] ?? "").trim() || "Ticket" : "Ticket", price, bookingFee, facilityFee, transactionFee,
      total: c.total >= 0 ? amt(r[c.total], line, "Total paid") : price + bookingFee + facilityFee + transactionFee,
      checkedIn: c.checked >= 0 && yes(r[c.checked]), addOn: c.addOn >= 0 && yes(r[c.addOn]), eventName: c.event >= 0 ? (r[c.event] ?? "").trim() || null : null };
  });
}

// ---------- calculation ----------
export type StripeSale = { order: string | null; amount: number; commission: number; refunded: boolean; /** every order ref on the payment (a basket can pay several) */ orders?: string[] };

/**
 * Pure reconciliation of export rows against the event's Stripe sales. Bilit's fee per order = booking + transaction fee
 * from the export; facility fees and add-ons are the organiser's. Orders whose Stripe sale was refunded, paid less than
 * the export says, or have no Stripe sale keep their booked fee (listed for review, never corrected blindly).
 */
export function computeImport(rows: TicketRow[], sales: StripeSale[], currency: string): { summary: ImportSummary; orders: OrderLine[] } {
  // One Stripe payment can cover several orders ("Order (A) … Order (B) …"): the later ones are reconciled as part of the first.
  const alias = new Map<string, string>();
  for (const s of sales) for (const o of s.orders ?? []) if (s.order && o !== s.order) alias.set(o, s.order);
  rows = rows.map((r) => alias.has(r.order) ? { ...r, order: alias.get(r.order)! } : r);
  const mergedInto = new Map<string, string[]>();
  for (const [o, into] of alias) mergedInto.set(into, [...(mergedInto.get(into) ?? []), o]);
  const byOrder = new Map<string, TicketRow[]>();
  for (const r of rows) byOrder.set(r.order, [...(byOrder.get(r.order) ?? []), r]);
  const sale = new Map<string, StripeSale>(); const unref: StripeSale[] = [];
  for (const s of sales) { if (!s.order) { unref.push(s); continue; } const p = sale.get(s.order); sale.set(s.order, p ? { order: s.order, amount: p.amount + s.amount, commission: p.commission + s.commission, refunded: p.refunded || s.refunded } : s); }
  const orders: OrderLine[] = [];
  for (const [order, rs] of byOrder) {
    const price = rs.reduce((a, r) => a + r.price + r.facilityFee, 0), fee = rs.reduce((a, r) => a + r.bookingFee + r.transactionFee, 0), total = rs.reduce((a, r) => a + r.total, 0);
    const s = sale.get(order) ?? null, free = total === 0;
    const base = { order, tickets: rs.length, free, types: [...new Set(rs.map((r) => r.type))], price, fee, total, addOnTickets: rs.filter((r) => r.addOn).length, stripe: s?.amount ?? null, bookedFee: s?.commission ?? null, ...(mergedInto.has(order) ? { merged: mergedInto.get(order) } : {}) };
    if (!s) { orders.push({ ...base, addOnAmount: 0, targetFee: null, status: free ? "FREE" : "SITE_ONLY" }); continue; }
    if (s.refunded) { orders.push({ ...base, addOnAmount: 0, targetFee: null, status: "REFUNDED" }); continue; }
    if (s.amount < total) { orders.push({ ...base, addOnAmount: 0, targetFee: null, status: "AMOUNT_LOW" }); continue; }
    orders.push({ ...base, addOnAmount: s.amount - total, targetFee: fee, status: "MATCHED" });
  }
  const matched = orders.filter((o) => o.status === "MATCHED");
  // Paid-looking orders with no Stripe payment were never paid for: they are not ticket sales of the event.
  const unpaidSet = new Set(orders.filter((o) => o.status === "SITE_ONLY").map((o) => o.order));
  const allRows = rows;
  rows = rows.filter((r) => !unpaidSet.has(r.order));
  const types = new Map<string, TypeLine>();
  for (const r of rows) { const t = types.get(r.type) ?? { type: r.type, tickets: 0, paid: 0, free: 0, price: 0, fee: 0 }; t.tickets++; if (r.total === 0) t.free++; else t.paid++; t.price += r.price + r.facilityFee; t.fee += r.bookingFee + r.transactionFee; types.set(r.type, t); }
  const rates = new Map<string, number>();
  for (const r of rows) if (r.price > 0 && !r.addOn) { const k = `${Math.round((r.bookingFee / r.price) * 1000) / 10}%`; rates.set(k, (rates.get(k) ?? 0) + 1); }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const bookedFee = sum(matched.map((o) => o.bookedFee ?? 0)), targetFee = sum(matched.map((o) => o.targetFee ?? 0));
  const summary: ImportSummary = {
    currency, rows: rows.length, tickets: rows.length, paidTickets: rows.filter((r) => r.total > 0).length, freeTickets: rows.filter((r) => r.total === 0).length, checkedIn: rows.filter((r) => r.checkedIn).length,
    orders: byOrder.size - unpaidSet.size, paidOrders: orders.filter((o) => !o.free && !unpaidSet.has(o.order)).length,
    ticketPrice: sum(rows.map((r) => r.price + r.facilityFee)), bookingFees: sum(rows.map((r) => r.bookingFee + r.transactionFee)), customersPaid: sum(rows.map((r) => r.total)),
    addOnTickets: rows.filter((r) => r.addOn && r.total > 0).length, addOnAmount: sum(matched.map((o) => o.addOnAmount)),
    byType: [...types.values()].sort((a, b) => b.price / Math.max(1, b.tickets) - a.price / Math.max(1, a.tickets)),
    feeRates: [...rates.entries()].map(([pct, tickets]) => ({ pct, tickets })).sort((a, b) => b.tickets - a.tickets),
    stripeSales: sales.length, stripeAmount: sum(sales.map((s) => s.amount)), matchedOrders: matched.length,
    siteOnly: orders.filter((o) => o.status === "SITE_ONLY").map((o) => ({ order: o.order, total: o.total })),
    stripeOnly: [...[...sale.values()].filter((s) => !byOrder.has(s.order!)), ...unref].map((s) => ({ order: s.order, amount: s.amount })),
    amountLow: orders.filter((o) => o.status === "AMOUNT_LOW").map((o) => ({ order: o.order, site: o.total, stripe: o.stripe ?? 0 })),
    refunded: orders.filter((o) => o.status === "REFUNDED").map((o) => o.order),
    bookedFee, targetFee, correction: bookedFee - targetFee,
    eventNames: [...new Set(allRows.map((r) => r.eventName).filter((x): x is string => !!x))],
    unpaid: orders.filter((o) => o.status === "SITE_ONLY").map((o) => ({ order: o.order, tickets: o.tickets, total: o.total, types: o.types })),
  };
  return { summary, orders };
}

// ---------- persistence ----------
async function eventSales(orgId: string, mode: Mode, eventId: string): Promise<StripeSale[]> {
  const r = await db.execute<{ order: string | null; orders: string[] | null; amount: string; commission: string; refunded: boolean }>(sql`
    select substring(coalesce(c.description, bt.description) from 'Order \\(([^)]+)\\)') as "order",
      array(select m[1] from regexp_matches(coalesce(c.description, bt.description, ''), 'Order \\(([^)]+)\\)', 'g') m) as orders, bt.amount::text as amount, coalesce(bt.commission_amount, 0)::text as commission,
      exists (select 1 from stripe_balance_transactions r where r.stripe_account_ref = bt.stripe_account_ref and r.charge_id = bt.charge_id and r.kind in ('REFUND', 'DISPUTE')) as refunded
    from stripe_balance_transactions bt left join stripe_charges c on c.stripe_account_ref = bt.stripe_account_ref and c.charge_id = bt.charge_id
    where bt.organisation_id = ${orgId} and bt.livemode = ${isLive(mode)} and bt.event_id = ${eventId} and bt.kind = 'SALE' and bt.match_status = 'MATCHED'`);
  // Sales paid outside the connected account (Bilit's other Stripe, or booked by hand) count as paid orders too.
  const m = await db.execute<{ order: string | null; amount: string; commission: string; refunded: boolean }>(sql`
    select e.reference as "order",
      sum(case when a.system_key = 'ticket_sales' then l.credit - l.debit else 0 end)::text as amount,
      sum(case when a.system_key = 'ticket_sales' then l.credit - l.debit when a.system_key = 'organiser_share' then l.credit - l.debit else 0 end)::text as commission,
      exists (select 1 from acct_journal_entries r where r.organisation_id = e.organisation_id and r.source_type = 'manual_refund' and r.reference = e.reference and r.event_id = e.event_id) as refunded
    from acct_journal_entries e join acct_journal_lines l on l.entry_id = e.id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${isLive(mode)} and e.event_id = ${eventId} and e.source_type = 'manual_sale' and e.entry_type <> 'REVERSAL'
      and not exists (select 1 from acct_journal_entries v where v.organisation_id = e.organisation_id and v.entry_type = 'REVERSAL' and v.source_type = 'manual_sale' and v.reference = e.reference and v.event_id = e.event_id)
    group by e.id, e.reference`);
  return [...r.rows.map((x) => ({ order: x.order, orders: x.orders ?? [], amount: Number(x.amount), commission: Number(x.commission), refunded: x.refunded })),
    ...m.rows.map((x) => ({ order: x.order, orders: x.order ? [x.order] : [], amount: Number(x.amount), commission: Number(x.commission), refunded: x.refunded }))];
}

async function loadEvent(orgId: string, eventId: string) {
  const [e] = await db.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, orgId)));
  if (!e) throw new AppError("not_found", "Event not found");
  return e;
}

/** Parse + reconcile an export and keep it as a PREVIEW (nothing is posted). */
export async function previewTicketImport(a: Actor, mode: Mode, eventId: string, csv: string, fileName: string | null) {
  const e = await loadEvent(a.orgId, eventId);
  const { summary, orders } = computeImport(parseTicketCsv(csv, e.currency), await eventSales(a.orgId, mode, eventId), e.currency);
  const [row] = await db.insert(schema.acctTicketImports).values({ organisationId: a.orgId, livemode: isLive(mode), eventId, fileName, summary, orders, createdBy: a.userId }).returning();
  return { id: row!.id, status: row!.status, fileName, createdAt: row!.createdAt, summary, orders, applied: await appliedTotal(a.orgId, mode, eventId) };
}

async function appliedTotal(orgId: string, mode: Mode, eventId: string, tx: Pick<typeof db, "select"> = db) {
  const [x] = await tx.select({ v: schema.acctTicketImports.appliedAmount }).from(schema.acctTicketImports)
    .where(and(eq(schema.acctTicketImports.organisationId, orgId), eq(schema.acctTicketImports.eventId, eventId), eq(schema.acctTicketImports.livemode, isLive(mode)), eq(schema.acctTicketImports.status, "APPLIED")));
  return x?.v ?? 0;
}

/** Imports of the event, newest first (summaries only). */
export async function listTicketImports(orgId: string, mode: Mode, eventId: string) {
  await loadEvent(orgId, eventId);
  const t = schema.acctTicketImports;
  const items = await db.select({ id: t.id, status: t.status, fileName: t.fileName, summary: t.summary, appliedAmount: t.appliedAmount, createdAt: t.createdAt, appliedAt: t.appliedAt })
    .from(t).where(and(eq(t.organisationId, orgId), eq(t.eventId, eventId), eq(t.livemode, isLive(mode)))).orderBy(desc(t.createdAt)).limit(20);
  return { items, applied: items.find((x) => x.status === "APPLIED") ?? null };
}

export async function getTicketImport(orgId: string, id: string) {
  const [x] = await db.select().from(schema.acctTicketImports).where(and(eq(schema.acctTicketImports.id, id), eq(schema.acctTicketImports.organisationId, orgId)));
  if (!x) throw new AppError("not_found", "Import not found");
  return x;
}

/** The applied import's summary for an event (used by the event report), or null. */
export async function appliedTicketImport(orgId: string, mode: Mode, eventId: string): Promise<ImportSummary | null> {
  const t = schema.acctTicketImports;
  const [x] = await db.select({ s: t.summary }).from(t).where(and(eq(t.organisationId, orgId), eq(t.eventId, eventId), eq(t.livemode, isLive(mode)), eq(t.status, "APPLIED")));
  return (x?.s as ImportSummary | undefined) ?? null;
}

/**
 * Apply a previewed import: recompute against the current Stripe sales (they may have changed since the preview), then
 * book the difference between the correction this import needs and what earlier applied imports already booked.
 */
export async function applyTicketImport(a: Actor, importId: string) {
  return db.transaction(async (tx) => {
    const t = schema.acctTicketImports;
    const [imp] = await tx.select().from(t).where(and(eq(t.id, importId), eq(t.organisationId, a.orgId))).for("update");
    if (!imp) throw new AppError("not_found", "Import not found");
    if (imp.status !== "PREVIEW") throw new AppError("invalid_state", imp.status === "APPLIED" ? "This import is already applied." : "A newer import replaced this one. Upload the file again.");
    const mode: Mode = imp.livemode ? "live" : "test";
    const [e] = await tx.select().from(schema.acctEvents).where(eq(schema.acctEvents.id, imp.eventId)).for("update");
    if (!e?.organiserId) throw new AppError("invalid_state", "Link this event to an organiser first.");
    const prior = await tx.select().from(t).where(and(eq(t.organisationId, a.orgId), eq(t.eventId, imp.eventId), eq(t.livemode, imp.livemode), eq(t.status, "APPLIED"))).for("update");
    const before = prior[0]?.appliedAmount ?? 0;
    // Re-derive from the stored rows so the books follow today's Stripe data, not the preview's snapshot.
    const rows = (imp.orders as OrderLine[]);
    const sales = await eventSales(a.orgId, mode, imp.eventId);
    const saleBy = new Map<string, StripeSale>(); for (const s of sales) if (s.order) { const p = saleBy.get(s.order); saleBy.set(s.order, p ? { ...p, amount: p.amount + s.amount, commission: p.commission + s.commission, refunded: p.refunded || s.refunded } : s); }
    let booked = 0, target = 0;
    for (const o of rows) { const s = saleBy.get(o.order); if (!s || s.refunded || s.amount < o.total) continue; booked += s.commission; target += o.fee; }
    const correction = booked - target, delta = correction - before;
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const today = new Date().toISOString().slice(0, 10);
    let entryId: string | null = null;
    if (delta !== 0) {
      const dims = { eventId: e.id, organiserId: e.organiserId };
      const { entry } = await postEntry(tx, {
        orgId: a.orgId, livemode: imp.livemode, entryType: "ADJUSTMENT", sourceDate: new Date(), entryDate: today, currency: e.currency,
        description: `Booking fee corrected to the ticket export — ${e.name} (${e.code})`, reference: imp.fileName ?? null, ...dims,
        sourceType: "ticket_import", sourceId: imp.id, idempotencyKey: `tix:${e.id}:${before}->${correction}`, createdBy: a.userId, timezone,
        // delta > 0: Bilit booked more fee than customers were charged, so that part is the organiser's.
        postings: [{ account: "organiser_share", amount: delta, ...dims, memo: "Booking fee correction (ticket export)" }, { account: "organiser_payable", amount: -delta, ...dims, memo: "Booking fee correction (ticket export)" }],
      });
      entryId = entry.id;
    }
    for (const p of prior) await tx.update(t).set({ status: "SUPERSEDED" }).where(eq(t.id, p.id));
    const [row] = await tx.update(t).set({ status: "APPLIED", appliedAmount: correction, journalEntryId: entryId, appliedBy: a.userId, appliedAt: new Date() }).where(eq(t.id, imp.id)).returning();
    await acctAudit(tx, { ...a, action: "ticket_import.applied", entity: "event", entityId: e.id, old: { correction: before }, new: { correction, booked, target, delta }, extra: { importId: imp.id, fileName: imp.fileName } });
    return { import: row!, booked, target, correction, delta };
  });
}
