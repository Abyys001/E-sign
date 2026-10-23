import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { parseMajor } from "@/lib/money";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { acctAudit, getAcctSettings, isLive, type Mode } from "./core";
import { postEntry, type Posting } from "./ledger";
import { btPostings, type Agreement } from "./postings";
import { parseCsv } from "./ticket-import";

/**
 * Sales taken on Bilit's OTHER (old) Stripe account, which is not connected to the books. The owner downloads that
 * account's Payments export (Stripe Dashboard → Payments → Export, CSV) and uploads it here. Each paid charge is matched
 * to an event by the code in its description ("Order (x) for event: NAME (B17-0073), by …") and booked like a normal
 * Stripe sale with the event's agreement — except the money sits in Bilit's bank, not the connected Stripe balance.
 * Entries: source_type manual_sale (sale) / manual_refund (refund), idempotency key per charge, so uploading the same
 * file twice changes nothing. Orders the connected Stripe account already has, or that were booked by hand, are skipped.
 */

type Actor = { orgId: string; userId: string; ctx: RequestContext };

export type OtherCharge = { id: string; created: Date; amount: number; refunded: number; fee: number; currency: string; status: string; description: string; customer: string | null };
export type LineStatus = "NEW" | "ALREADY_IMPORTED" | "IN_MAIN_STRIPE" | "BOOKED_BY_HAND" | "NO_EVENT" | "NO_AGREEMENT" | "CURRENCY_MISMATCH" | "NOT_PAID";
export type PreviewLine = {
  chargeId: string; date: string; order: string | null; eventCode: string | null; eventId: string | null; eventName: string | null; customer: string | null;
  currency: string; amount: number; refunded: number; fee: number; bookingFee: number | null; organiserShare: number | null; status: LineStatus;
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ORDER = /order\s*\(([^)]+)\)/i;
const CODE = /\(([A-Z]{1,4}\d{1,4}-\d{3,5})\)/i;

/** Charges from a Stripe Payments CSV export. Columns are found by header name; amounts are in major units ("1,792.00"). */
export function parseStripePaymentsCsv(text: string): OtherCharge[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new AppError("validation_failed", "The file has no payment rows.", [{ path: "file", message: "Empty file" }]);
  const head = rows[0]!.map(norm);
  const col = (...names: string[]) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const c = {
    id: col("id", "charge id", "payment id"), created: col("created date utc", "created utc", "created date", "created"), amount: col("amount"),
    refunded: col("amount refunded"), fee: col("fee"), currency: col("currency"), status: col("status"), captured: col("captured"),
    description: col("description"), customer: col("customer description", "customer name", "customer email", "card name"),
  };
  const missing = (["id", "created", "amount", "currency", "description"] as const).filter((k) => c[k] < 0);
  if (missing.length) throw new AppError("validation_failed", `This does not look like a Stripe Payments export (missing column: ${missing.join(", ")}). In the old Stripe account open Payments → Export and choose CSV.`, [{ path: "file", message: "Wrong file" }]);
  const out: OtherCharge[] = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const get = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
    const id = get(c.id); if (!id) continue;
    const currency = get(c.currency).toLowerCase();
    const money = (k: number) => { const v = get(k); if (!v) return 0; try { return parseMajor(v, currency); } catch { throw new AppError("validation_failed", `Row ${i + 2}: "${v}" is not an amount.`, [{ path: "file", message: "Bad amount" }]); } };
    const createdRaw = get(c.created);
    const created = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(createdRaw) ? createdRaw : `${createdRaw.replace(" ", "T")}Z`);
    if (Number.isNaN(created.getTime())) throw new AppError("validation_failed", `Row ${i + 2}: "${createdRaw}" is not a date.`, [{ path: "file", message: "Bad date" }]);
    const captured = get(c.captured).toLowerCase();
    const status = (get(c.status) || (captured === "false" ? "uncaptured" : "paid")).toLowerCase();
    out.push({ id, created, amount: money(c.amount), refunded: money(c.refunded), fee: money(c.fee), currency, status, description: get(c.description), customer: get(c.customer) || null });
  }
  if (!out.length) throw new AppError("validation_failed", "The file has no payment rows.", [{ path: "file", message: "Empty file" }]);
  return out;
}

const paid = (s: string) => ["paid", "succeeded", "refunded", "partially refunded", "partially_refunded"].includes(s);
const localDate = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function context(orgId: string, mode: Mode, charges: OtherCharge[]) {
  // Every event of the org: a payment belongs to the event whose code appears in brackets in its description.
  const events = await db.select({ e: schema.acctEvents, ag: schema.acctAgreements }).from(schema.acctEvents)
    .leftJoin(schema.acctAgreements, eq(schema.acctAgreements.id, schema.acctEvents.currentAgreementId))
    .where(eq(schema.acctEvents.organisationId, orgId));
  const keys = charges.map((x) => `other_stripe:${x.id}`);
  const imported = new Set((await db.select({ k: schema.acctJournalEntries.idempotencyKey }).from(schema.acctJournalEntries)
    .where(and(eq(schema.acctJournalEntries.organisationId, orgId), inArray(schema.acctJournalEntries.idempotencyKey, keys)))).map((r) => r.k));
  const orders = [...new Set(charges.map((x) => ORDER.exec(x.description)?.[1]).filter(Boolean) as string[])];
  const byHand = new Set(orders.length ? (await db.select({ r: schema.acctJournalEntries.reference }).from(schema.acctJournalEntries)
    .where(and(eq(schema.acctJournalEntries.organisationId, orgId), eq(schema.acctJournalEntries.sourceType, "manual_sale"), inArray(schema.acctJournalEntries.reference, orders), sql`${schema.acctJournalEntries.idempotencyKey} not like 'other_stripe:%'`))).map((r) => r.r) : []);
  // The connected account's own charges: an order that is already there is not "other Stripe" money.
  const main = new Set<string>();
  for (const o of orders) {
    const [hit] = await db.select({ id: schema.stripeCharges.id }).from(schema.stripeCharges)
      .where(and(eq(schema.stripeCharges.organisationId, orgId), eq(schema.stripeCharges.livemode, isLive(mode)), eq(schema.stripeCharges.status, "succeeded"), sql`${schema.stripeCharges.description} ilike ${`%Order (${o})%`}`)).limit(1);
    if (hit) main.add(o);
  }
  return { events, imported, byHand, main };
}

function plan(ch: OtherCharge, ctx: Awaited<ReturnType<typeof context>>, tz: string) {
  const order = ORDER.exec(ch.description)?.[1] ?? null;
  const d = ch.description.toUpperCase();
  const ev = ctx.events.filter((r) => d.includes(`(${r.e.code.toUpperCase()})`)).sort((x, y) => y.e.code.length - x.e.code.length)[0];
  const code = ev?.e.code ?? CODE.exec(ch.description)?.[1]?.toUpperCase() ?? null;
  const base: PreviewLine = { chargeId: ch.id, date: localDate(ch.created, tz), order, eventCode: ev?.e.code ?? code, eventId: ev?.e.id ?? null, eventName: ev?.e.name ?? null, customer: ch.customer,
    currency: ch.currency, amount: ch.amount, refunded: ch.refunded, fee: ch.fee, bookingFee: null, organiserShare: null, status: "NEW" };
  const st = (status: LineStatus) => ({ line: { ...base, status }, sale: null as null | ReturnType<typeof btPostings>, refund: null as null | ReturnType<typeof btPostings>, ev });
  if (!paid(ch.status) || ch.amount <= 0) return st("NOT_PAID");
  if (ctx.imported.has(`other_stripe:${ch.id}`)) return st("ALREADY_IMPORTED");
  if (order && ctx.main.has(order)) return st("IN_MAIN_STRIPE");
  if (order && ctx.byHand.has(order)) return st("BOOKED_BY_HAND");
  if (!ev) return st("NO_EVENT");
  if (!ev.ag || !ev.e.organiserId) return st("NO_AGREEMENT");
  if (ev.e.currency !== ch.currency) return st("CURRENCY_MISMATCH");
  const matched = { eventId: ev.e.id, organiserId: ev.e.organiserId, agreement: ev.ag as unknown as Agreement };
  const sale = btPostings({ kind: "SALE", amount: ch.amount, fee: ch.fee, net: ch.amount - ch.fee, matched });
  const refund = ch.refunded > 0 ? btPostings({ kind: "REFUND", amount: -ch.refunded, fee: 0, net: -ch.refunded, matched, original: { amount: ch.amount, commission: sale.commission ?? 0 } }) : null;
  return { line: { ...base, bookingFee: sale.commission, organiserShare: sale.organiserAmount }, sale, refund, ev };
}

/** The money is in Bilit's bank (via the other account's payouts), never in the connected Stripe balance. */
const toBank = (ps: Posting[]) => ps.map((p) => (p.account === "stripe_balance" ? { ...p, account: "bank" as const, memo: "Received on Bilit's other Stripe account" } : p));

function totals(lines: PreviewLine[]) {
  const by = new Map<string, { currency: string; payments: number; amount: number; refunded: number; fee: number; bookingFee: number; organiserShare: number }>();
  for (const l of lines.filter((x) => x.status === "NEW")) {
    const t = by.get(l.currency) ?? { currency: l.currency, payments: 0, amount: 0, refunded: 0, fee: 0, bookingFee: 0, organiserShare: 0 };
    t.payments++; t.amount += l.amount; t.refunded += l.refunded; t.fee += l.fee; t.bookingFee += l.bookingFee ?? 0; t.organiserShare += (l.organiserShare ?? 0) - l.refunded;
    by.set(l.currency, t);
  }
  return [...by.values()];
}

/** Read the export and show what would be booked. Nothing is posted. */
export async function previewOtherStripe(orgId: string, mode: Mode, csv: string) {
  const charges = parseStripePaymentsCsv(csv);
  const { timezone } = await getAcctSettings(orgId);
  const ctx = await context(orgId, mode, charges);
  const lines = charges.map((c) => plan(c, ctx, timezone).line).sort((a, b) => a.date.localeCompare(b.date));
  return { lines, totals: totals(lines), counts: Object.fromEntries((["NEW", "ALREADY_IMPORTED", "IN_MAIN_STRIPE", "BOOKED_BY_HAND", "NO_EVENT", "NO_AGREEMENT", "CURRENCY_MISMATCH", "NOT_PAID"] as LineStatus[]).map((s) => [s, lines.filter((l) => l.status === s).length])) };
}

/** Book every NEW payment of the export (sale + refund). Re-running is safe: each charge has its own idempotency key. */
export async function applyOtherStripe(a: Actor, mode: Mode, csv: string, fileName: string | null) {
  const charges = parseStripePaymentsCsv(csv);
  const { timezone } = await getAcctSettings(a.orgId);
  const ctx = await context(a.orgId, mode, charges);
  const booked: string[] = [], failed: Array<{ chargeId: string; error: string }> = [];
  for (const ch of charges) {
    const p = plan(ch, ctx, timezone);
    if (p.line.status !== "NEW" || !p.sale || !p.ev) continue;
    const dims = { eventId: p.ev.e.id, organiserId: p.ev.e.organiserId };
    const desc = `${ch.description || `Payment ${ch.id}`} — Bilit's other Stripe account (${ch.id})`;
    try {
      await db.transaction(async (tx) => {
        const { entry, created } = await postEntry(tx, {
          orgId: a.orgId, livemode: isLive(mode), entryType: "OTHER_STRIPE_SALE", sourceDate: ch.created, entryDate: p.line.date, currency: ch.currency, description: desc,
          reference: p.line.order ?? ch.id, ...dims, sourceType: "manual_sale", sourceId: null, idempotencyKey: `other_stripe:${ch.id}`, createdBy: a.userId, timezone, postings: toBank(p.sale!.postings),
        });
        if (p.refund) await postEntry(tx, {
          orgId: a.orgId, livemode: isLive(mode), entryType: "OTHER_STRIPE_REFUND", sourceDate: ch.created, entryDate: p.line.date, currency: ch.currency, description: `Refund: ${desc}`,
          reference: p.line.order ?? ch.id, ...dims, sourceType: "manual_refund", sourceId: null, idempotencyKey: `other_stripe_refund:${ch.id}:${ch.refunded}`, createdBy: a.userId, timezone, postings: toBank(p.refund.postings),
        });
        if (created) await acctAudit(tx, { ...a, action: "other_stripe.sale_imported", entity: "journal_entry", entityId: entry.id, new: { chargeId: ch.id, order: p.line.order, event: p.ev!.e.code, amount: ch.amount, refunded: ch.refunded, fee: ch.fee, file: fileName } });
      });
      booked.push(ch.id);
    } catch (e) { failed.push({ chargeId: ch.id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { booked: booked.length, failed, ...(await previewOtherStripe(a.orgId, mode, csv)) };
}
