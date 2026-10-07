import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { currencyExponent, formatMoney, parseMajor } from "@/lib/money";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { log } from "../logger";
import { bookkeepingChecks } from "./accountant";
import { aiConfig } from "./ai";
import { acctAudit, getAcctSettings, IsoDate, localDate, type Mode } from "./core";
import { eventFinancials, financeOverview, organiserBalances, organiserFinancials } from "./finance";
import { createBill } from "./books";
import { listPartners, partnerOverview, recordPartnerPayment } from "./profit-share";
import { editOrganiserPayment, markPaymentPaid, recordOrganiserPayment, voidOrganiserPayment } from "./manual";
import { listPayments, listTransactions } from "./queries";
import { getWiseStatus, listWise, setWiseIgnored, syncWise } from "./wise";

/**
 * Finance chat agent: a conversation with an AI accountant that looks things up itself (organisers, events, payments,
 * Wise, Stripe, checks) through read-only tools, and can PROPOSE changes (record / mark paid / edit / void a payment,
 * mark a Wise transfer as not an organiser payment). Proposals are returned to the browser as cards; nothing changes
 * until the admin presses Confirm, which calls `executeAction` with the normal permission and audit checks.
 * Ticket buyers' personal data is never given to the model.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const AgentChatInput = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) })).min(1).max(30)
    .refine((m) => m[m.length - 1]!.role === "user", "The last message must be from you"),
});

const Method = z.enum(["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"]);
export const AgentAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record_payment"), mode: z.enum(["test", "live"]), organiserId: z.string().uuid(), eventId: z.string().uuid().nullable(), amount: z.number().int().positive(), currency: z.string().regex(/^[a-z]{3}$/), paymentDate: IsoDate, method: Method, bankReference: z.string().max(120).nullable(), notes: z.string().max(2000).nullable(), status: z.enum(["PAID", "PENDING"]) }),
  z.object({ kind: z.literal("mark_paid"), paymentId: z.string().uuid(), paymentDate: IsoDate.nullable(), bankReference: z.string().max(120).nullable() }),
  z.object({ kind: z.literal("edit_payment"), paymentId: z.string().uuid(), amount: z.number().int().positive().nullable(), paymentDate: IsoDate.nullable(), bankReference: z.string().max(120).nullable(), notes: z.string().max(2000).nullable(), eventId: z.string().uuid().nullable().optional(), reason: z.string().min(3).max(1000) }),
  z.object({ kind: z.literal("void_payment"), paymentId: z.string().uuid(), reason: z.string().min(3).max(1000) }),
  z.object({ kind: z.literal("record_expense"), mode: z.enum(["test", "live"]), docKind: z.enum(["EXPENSE", "BILL"]), supplierName: z.string().min(1).max(200), invoiceNumber: z.string().max(80).nullable(), date: IsoDate, currency: z.string().regex(/^[a-z]{3}$/), netAmount: z.number().int().min(0), vatAmount: z.number().int().min(0), accountId: z.string().uuid(), eventId: z.string().uuid().nullable(), description: z.string().max(2000).nullable(), paidFrom: z.enum(["BANK", "CARD", "CASH", "EMPLOYEE"]), paymentReference: z.string().max(120).nullable() }),
  z.object({ kind: z.literal("partner_payment"), mode: z.enum(["test", "live"]), partnerId: z.string().uuid(), amount: z.number().int().positive(), currency: z.string().regex(/^[a-z]{3}$/), paymentDate: IsoDate, method: Method, bankReference: z.string().max(120).nullable(), notes: z.string().max(2000).nullable() }),
  z.object({ kind: z.literal("wise_ignore"), wiseTransactionId: z.string().uuid(), reason: z.string().min(3).max(500) }),
]);
export type AgentActionT = z.infer<typeof AgentAction>;
const parseAs = <K extends AgentActionT["kind"]>(kind: K, v: Record<string, unknown>) => AgentAction.parse({ kind, ...v }) as Extract<AgentActionT, { kind: K }>;
export type Proposal = { id: string; summary: string; action: AgentActionT; needsElevation: boolean };

export const AGENT_SYSTEM = `You are Bilit's in-house senior accountant, working inside the Finance section of Bilit's own system. You talk with the finance admin (the owner) like a trusted colleague: concise, precise, practical. You can look things up yourself with tools, and you can propose changes to the books, which the admin confirms with a button.

How Bilit works: customers pay ticket price + a booking fee added on top; Bilit sells tickets as agent for event organisers, so the ticket money belongs to the organiser and Bilit's revenue is the booking fee. The booking fee is non-refundable for Bilit: if a refund includes it, the organiser is charged for it. Amount due to an organiser = ticket sales − refunds − booking fee − Stripe fees they bear − deductions; remaining = due − paid; negative = the organiser owes Bilit. Bilit pays organisers by Stripe payout straight to their bank, from its Wise account (often converting currency, e.g. GBP→CAD), or from its Stripe wallet (Stripe "balance transfer" payouts move money into a Stripe financial account; outbound payments go on from there). Stripe payouts into Wise show as incoming "Stripe Payments UK Ltd". Payments can also go to third parties on an organiser's behalf (venue, city tax) and are then recorded as payments to that organiser.

Rules:
- ALWAYS check the data with tools before answering a factual question or proposing a change. Never invent figures, ids or references. Quote amounts with currency; never add different currencies together. Say which organiser/event each figure belongs to.
- To change anything use the propose_* tools. A proposal is NOT done — tell the admin it is waiting for their confirmation (a Confirm button appears under your message). Never say a change was made unless the conversation shows it was confirmed.
- Before proposing a payment: find the organiser (search_organisers), check their balance and existing payments for duplicates (organiser_account / list_payments), and when it came from Wise or Stripe, find the source transaction and use its number as the bank reference (e.g. "Wise #2417781233", Stripe payout id). Company policy: record a payment as made, against the organiser as a whole, NOT split across events, unless the admin says which event it is for. Fees and FX: record the amount in the currency of the organiser's balance; note the other side and any fee in the notes.
- A Wise or bank payment can also be a cost of Bilit's: book it with propose_record_expense — EXPENSE when there is no invoice to keep track of, BILL when there is a supplier invoice (paid, so the admin can attach the PDF later). Pick the category with expense_categories; split out VAT only when the admin says the supplier charged VAT.
- Profit share: some partners (e.g. Morteza, the web developer) earn a % of each event's profit; it is booked automatically as a cost owed to them. Use profit_share to answer questions about it and propose_partner_payment when Bilit paid them (e.g. Wise "To Morteza Dev").
- If something is ambiguous, ask one short question instead of guessing. Flag accounting concerns (overpayment, duplicates, missing references, money that never left) like a careful accountant would.
- Answer in the language of the question. Use short lists or small markdown tables when helpful.`;

// ---------- tools ----------
const TOOLS = [
  fn("search_organisers", "Find organisers by name/company (empty query = all) with their balance per currency (due, paid, remaining).", { query: { type: "string" } }),
  fn("organiser_account", "Full account of one organiser: totals per currency, every event with due/paid/remaining, and all their payments.", { organiserId: { type: "string" } }, ["organiserId"]),
  fn("list_events", "Events with sales, booking fees, organiser due/paid/remaining. Filter by text (name/code) or organiser.", { query: { type: "string" }, organiserId: { type: "string" } }),
  fn("list_payments", "Organiser payments in the books (id, date, amount, method, reference, status, notes). Filters optional.", { organiserId: { type: "string" }, status: { type: "string", enum: ["PAID", "PENDING", "VOIDED"] }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string" }, query: { type: "string", description: "text in reference/notes/organiser/event" } }),
  fn("wise_transactions", "Bilit's Wise account movements (transfers out, incoming Stripe payouts, card spend, conversions) and whether each transfer is linked to an organiser payment.", { view: { type: "string", enum: ["torecord", "out", "in", "all", "ignored"] }, query: { type: "string" }, from: { type: "string" }, to: { type: "string" } }),
  fn("wise_status", "Wise connection status and current balances.", {}),
  fn("sync_wise", "Pull the latest activity from Wise now (read-only towards Wise).", {}),
  fn("stripe_payouts", "Stripe payouts (to banks, to Wise, or 'Balance transfer' into the Stripe wallet), with description/statement text.", { from: { type: "string" }, to: { type: "string" }, query: { type: "string" } }),
  fn("stripe_transactions", "Stripe balance transactions (sales, refunds, fees, payouts). No customer personal data.", { query: { type: "string", description: "event code, description text, or Stripe id" }, from: { type: "string" }, to: { type: "string" }, kind: { type: "string" } }),
  fn("books_overview", "Totals per currency for a period: sales, booking fees, Bilit profit, organiser due/paid/outstanding.", { from: { type: "string" }, to: { type: "string" } }),
  fn("health_checks", "Automated bookkeeping checks (unmatched sales, suspense, pending payments, Wise transfers not in the books).", {}),
  fn("propose_record_payment", "Propose recording a payment Bilit made (or will make) to an organiser. Amount in major units.", { organiserId: { type: "string" }, eventId: { type: ["string", "null"] }, amount: { type: "number" }, currency: { type: "string" }, paymentDate: { type: "string" }, method: { type: "string", enum: ["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"] }, bankReference: { type: ["string", "null"] }, notes: { type: ["string", "null"] }, status: { type: "string", enum: ["PAID", "PENDING"] } }, ["organiserId", "amount", "currency", "paymentDate", "method", "status"]),
  fn("propose_mark_paid", "Propose marking a PENDING payment as paid (optionally with the actual date and bank reference).", { paymentId: { type: "string" }, paymentDate: { type: ["string", "null"] }, bankReference: { type: ["string", "null"] } }, ["paymentId"]),
  fn("propose_edit_payment", "Propose editing a payment (amount in major units, date, reference, notes, event). Give a reason.", { paymentId: { type: "string" }, amount: { type: ["number", "null"] }, paymentDate: { type: ["string", "null"] }, bankReference: { type: ["string", "null"] }, notes: { type: ["string", "null"] }, eventId: { type: ["string", "null"] }, reason: { type: "string" } }, ["paymentId", "reason"]),
  fn("propose_void_payment", "Propose voiding (cancelling) a recorded payment; the ledger entry is reversed and history kept.", { paymentId: { type: "string" }, reason: { type: "string" } }, ["paymentId", "reason"]),
  fn("profit_share", "Profit-share partners (e.g. Morteza, web developer, 10% of each event's profit): share earned, paid and still owed per currency, per event and per month, and payments made. Without partnerId returns the list of partners.", { partnerId: { type: "string" } }),
  fn("propose_partner_payment", "Propose recording a payment Bilit made to a profit-share partner (reduces what is owed). Amount in major units, in the currency of the share being paid off.", { partnerId: { type: "string" }, amount: { type: "number" }, currency: { type: "string" }, paymentDate: { type: "string" }, method: { type: "string", enum: ["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"] }, bankReference: { type: ["string", "null"] }, notes: { type: ["string", "null"] } }, ["partnerId", "amount", "currency", "paymentDate"]),
  fn("expense_categories", "Expense categories (chart of accounts) to book supplier invoices / expenses against.", {}),
  fn("propose_record_expense", "Propose booking a payment Bilit made to a supplier as an EXPENSE (paid, no invoice to track) or a supplier invoice BILL (already paid). Amounts in major units; total = net + vat. For Wise movements use bankReference \"Wise #<number>\" so it links to the Wise transaction.", { docKind: { type: "string", enum: ["EXPENSE", "BILL"] }, supplierName: { type: "string" }, invoiceNumber: { type: ["string", "null"] }, date: { type: "string" }, currency: { type: "string" }, total: { type: "number" }, vat: { type: ["number", "null"] }, accountId: { type: "string" }, eventId: { type: ["string", "null"] }, description: { type: ["string", "null"] }, paidFrom: { type: "string", enum: ["BANK", "CARD", "CASH", "EMPLOYEE"] }, bankReference: { type: ["string", "null"] } }, ["docKind", "supplierName", "date", "currency", "total", "accountId"]),
  fn("propose_wise_ignore", "Propose marking a Wise transfer as NOT an organiser payment (own account, supplier, salary, loan…).", { wiseTransactionId: { type: "string" }, reason: { type: "string" } }, ["wiseTransactionId", "reason"]),
];
function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: "function" as const, function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

const S = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const D = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const cap = (o: unknown, n = 14_000) => { const s = JSON.stringify(o); return s.length > n ? `${s.slice(0, n)}…(truncated — narrow the filter)` : s; };
const toMinor = (v: number, cur: string) => parseMajor(Number(v).toFixed(currencyExponent(cur)), cur);

type Ctx = { a: Actor; mode: Mode; proposals: Proposal[]; m: (v: number, c: string) => string };

async function runTool(c: Ctx, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { a, mode, m } = c;
  const orgName = async (id: string) => (await db.select({ n: schema.acctOrganisers.name }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, id), eq(schema.acctOrganisers.organisationId, a.orgId))))[0]?.n ?? null;
  const pay = async (id: string) => (await db.select().from(schema.acctOrganiserPayments).where(and(eq(schema.acctOrganiserPayments.id, id), eq(schema.acctOrganiserPayments.organisationId, a.orgId))))[0];
  switch (name) {
    case "search_organisers": {
      const q = S(args.query)?.toLowerCase();
      const [orgs, bal] = await Promise.all([db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, a.orgId)), organiserBalances(a.orgId, mode)]);
      return orgs.filter((o) => !q || `${o.name} ${o.companyName ?? ""} ${o.internalRef ?? ""}`.toLowerCase().includes(q)).map((o) => ({ id: o.id, name: o.name, company: o.companyName, active: o.active,
        balances: bal.filter((b) => b.organiserId === o.id).map((b) => ({ currency: b.currency, due: m(b.organiserDue, b.currency), paid: m(b.organiserPaid, b.currency), remaining: m(b.remaining, b.currency), pending: m(b.pendingPayments, b.currency), status: b.settlement })) }));
    }
    case "organiser_account": {
      const id = String(args.organiserId ?? "");
      const name = await orgName(id); if (!name) return { error: "Organiser not found — use search_organisers to get the id." };
      const [f, p] = await Promise.all([organiserFinancials(a.orgId, mode, id), listPayments(a.orgId, mode, { organiserId: id }, { limit: 200, offset: 0 })]);
      return { organiser: name, totals: f.totals.map((t) => ({ currency: t.currency, due: m(t.organiserDue, t.currency), paid: m(t.organiserPaid, t.currency), remaining: m(t.remaining, t.currency), pending: m(t.pendingPayments, t.currency) })),
        events: f.events.map((e) => ({ eventId: e.eventId, code: e.eventCode, name: e.eventName, date: e.startsOn, status: e.eventStatus, currency: e.currency, gross: m(e.grossSales, e.currency), bookingFees: m(e.bookingFees, e.currency), due: m(e.organiserDue, e.currency), paid: m(e.organiserPaid, e.currency), remaining: m(e.remaining, e.currency), settlement: e.settlement })),
        payments: p.items.map((x) => ({ paymentId: x.id, date: x.paymentDate, amount: m(x.amount, x.currency), event: x.eventCode ?? "whole organiser", method: x.method, reference: x.bankReference, status: x.status, notes: x.notes, voidReason: x.voidReason })) };
    }
    case "list_events": {
      const rows = await eventFinancials(a.orgId, mode, { q: S(args.query), organiserId: S(args.organiserId) });
      return rows.slice(0, 80).map((e) => ({ eventId: e.eventId, code: e.eventCode, name: e.eventName, date: e.startsOn, status: e.eventStatus, organiser: e.organiserName, organiserId: e.organiserId, currency: e.currency, tickets: e.tickets, gross: m(e.grossSales, e.currency), refunds: m(e.refunds, e.currency), bookingFeePercent: (e.bookingFeeBps ?? 0) / 100, bookingFees: m(e.bookingFees, e.currency), due: m(e.organiserDue, e.currency), paid: m(e.organiserPaid, e.currency), remaining: m(e.remaining, e.currency), bilitProfit: m(e.bilitProfit, e.currency) }));
    }
    case "list_payments": {
      const r = await listPayments(a.orgId, mode, { organiserId: S(args.organiserId), status: S(args.status) }, { limit: 500, offset: 0 });
      const q = S(args.query)?.toLowerCase(), from = D(args.from), to = D(args.to);
      return r.items.filter((x) => (!from || x.paymentDate >= from) && (!to || x.paymentDate <= to) && (!q || `${x.bankReference ?? ""} ${x.notes ?? ""} ${x.organiserName} ${x.eventName ?? ""} ${x.eventCode ?? ""}`.toLowerCase().includes(q))).slice(0, 120)
        .map((x) => ({ paymentId: x.id, date: x.paymentDate, organiser: x.organiserName, organiserId: x.organiserId, event: x.eventCode ? `${x.eventCode} ${x.eventName}` : "whole organiser", amount: m(x.amount, x.currency), method: x.method, reference: x.bankReference, status: x.status, notes: x.notes }));
    }
    case "wise_status": return getWiseStatus(a.orgId);
    case "sync_wise": return syncWise(a.orgId, { userId: a.userId, ctx: a.ctx });
    case "wise_transactions": {
      const view = (["torecord", "out", "in", "all", "ignored"] as const).find((v) => v === args.view) ?? "all";
      const r = await listWise(a.orgId, { view, q: S(args.query) }, { limit: 300, offset: 0 });
      const from = D(args.from), to = D(args.to);
      return { total: r.total, items: r.items.filter((x) => { const d = x.occurredAt.toISOString().slice(0, 10); return (!from || d >= from) && (!to || d <= to); }).slice(0, 120).map((x) => ({ wiseTransactionId: x.id, wiseId: x.wiseId.split(":")[0], referenceToUse: `Wise #${x.refNumber}`, date: x.occurredAt.toISOString().slice(0, 16), direction: x.direction, kind: x.kind, status: x.status, counterparty: x.counterparty, amount: m(x.amount, x.currency), paidFrom: x.sourceCurrency && x.sourceCurrency !== x.currency && x.sourceAmount != null ? m(x.sourceAmount, x.sourceCurrency) : undefined, fee: x.fee ? m(x.fee, x.sourceCurrency ?? x.currency) : undefined, reference: x.reference, inBooksAs: x.billId ? `${x.billKind === "BILL" ? "supplier invoice" : "expense"}: ${x.billSupplier}` : x.organiserPaymentId ? `payment to ${x.paymentOrganiserName}` : x.stripePayoutId ? `Stripe payout ${x.stripePayoutId}` : x.ignored ? `other: ${x.ignoredReason}` : null, suggestedOrganiser: x.suggestedName })) };
    }
    case "stripe_payouts": {
      const p = schema.stripePayouts, from = D(args.from), to = D(args.to), q = S(args.query);
      const rows = await db.select().from(p).where(and(eq(p.organisationId, a.orgId), eq(p.livemode, mode === "live"), from ? gte(p.stripeCreatedAt, new Date(`${from}T00:00:00Z`)) : undefined, to ? lte(p.stripeCreatedAt, new Date(`${to}T23:59:59Z`)) : undefined,
        q ? sql`(${p.payoutId} ilike ${`%${q}%`} or ${p.description} ilike ${`%${q}%`} or ${p.statementDescriptor} ilike ${`%${q}%`})` : undefined)).orderBy(desc(p.stripeCreatedAt)).limit(150);
      const refs = await db.select({ ref: schema.acctOrganiserPayments.bankReference, org: schema.acctOrganisers.name }).from(schema.acctOrganiserPayments).innerJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, schema.acctOrganiserPayments.organiserId)).where(and(eq(schema.acctOrganiserPayments.organisationId, a.orgId), sql`${schema.acctOrganiserPayments.status} <> 'VOIDED'`));
      return rows.map((x) => ({ payoutId: x.payoutId, created: x.stripeCreatedAt.toISOString().slice(0, 16), arrival: x.arrivalDate?.toISOString().slice(0, 10), amount: m(x.amount, x.currency), status: x.status, manual: !x.automatic, description: x.description, statementText: x.statementDescriptor, recordedAsPaymentTo: refs.find((r) => r.ref?.includes(x.payoutId))?.org ?? null }));
    }
    case "stripe_transactions": {
      const r = await listTransactions(a.orgId, mode, { q: S(args.query), from: D(args.from), to: D(args.to), kind: S(args.kind) }, { limit: 100, offset: 0 }, false);
      return r.items.map((x) => ({ id: x.balanceTransactionId, date: x.stripeCreatedAt.toISOString().slice(0, 10), kind: x.kind, amount: m(x.amount, x.currency), fee: m(x.fee, x.currency), net: m(x.net, x.currency), eventCode: x.eventCode, event: x.eventName, organiser: x.organiserName, match: x.matchStatus, payoutId: x.payoutId }));
    }
    case "books_overview": {
      const o = await financeOverview(a.orgId, mode, { from: D(args.from) ?? null, to: D(args.to) ?? null });
      return { totals: o.totals.map((t) => ({ currency: t.currency, tickets: t.tickets, gross: m(t.grossSales, t.currency), refunds: m(t.refunds, t.currency), bookingFees: m(t.bookingFees, t.currency), stripeFees: m(t.processingFees, t.currency), bilitProfit: m(t.bilitProfit, t.currency), organiserDue: m(t.organiserDue, t.currency), organiserPaid: m(t.organiserPaid, t.currency), outstanding: m(t.remaining, t.currency) })), events: o.totalEvents };
    }
    case "health_checks": {
      const [checks, pend, w] = await Promise.all([bookkeepingChecks(a.orgId, mode, { from: "2000-01-01", to: "2100-12-31" }), listPayments(a.orgId, mode, { status: "PENDING" }, { limit: 50, offset: 0 }), getWiseStatus(a.orgId)]);
      return { checks: checks.map((x) => ({ severity: x.severity, check: x.title, count: x.count, amounts: Object.entries(x.amounts ?? {}).map(([k, v]) => m(v, k)), guidance: x.detail })), pendingPayments: pend.items.map((x) => ({ paymentId: x.id, date: x.paymentDate, organiser: x.organiserName, amount: m(x.amount, x.currency), event: x.eventCode })), wiseTransfersNotInBooks: "toRecord" in w ? w.toRecord : null };
    }
    // ---------- proposals (never executed here) ----------
    case "propose_record_payment": {
      const organiserId = String(args.organiserId ?? ""), name = await orgName(organiserId);
      if (!name) return { error: "Organiser not found." };
      const currency = String(args.currency ?? "").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency) || !(Number(args.amount) > 0) || !D(args.paymentDate)) return { error: "Need a valid amount, 3-letter currency and YYYY-MM-DD date." };
      const eventId = S(args.eventId) ?? null; let label = "whole organiser";
      if (eventId) { const [e] = await db.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, a.orgId))); if (!e || e.organiserId !== organiserId || e.currency !== currency) return { error: "That event does not belong to this organiser or is in another currency." }; label = `${e.code} ${e.name}`; }
      const action = parseAs("record_payment", { mode, organiserId, eventId, amount: toMinor(Number(args.amount), currency), currency, paymentDate: D(args.paymentDate), method: Method.catch("BANK_TRANSFER").parse(args.method), bankReference: S(args.bankReference)?.slice(0, 120) ?? null, notes: S(args.notes)?.slice(0, 2000) ?? null, status: args.status === "PENDING" ? "PENDING" : "PAID" });
      return propose(c, `Record ${action.status === "PENDING" ? "pending " : ""}payment of ${m(action.amount, currency)} to ${name} (${label}) on ${action.paymentDate}${action.bankReference ? `, ref ${action.bankReference}` : ""} — ${mode.toUpperCase()} books`, action, false);
    }
    case "propose_mark_paid": {
      const p = await pay(String(args.paymentId ?? "")); if (!p) return { error: "Payment not found." };
      if (p.status !== "PENDING") return { error: `That payment is ${p.status}, not pending.` };
      const action = parseAs("mark_paid", { paymentId: p.id, paymentDate: D(args.paymentDate) ?? null, bankReference: S(args.bankReference)?.slice(0, 120) ?? null });
      return propose(c, `Mark ${m(p.amount, p.currency)} to ${await orgName(p.organiserId)} as PAID${action.paymentDate ? ` on ${action.paymentDate}` : ""}${action.bankReference ? `, ref ${action.bankReference}` : ""}`, action, false);
    }
    case "propose_edit_payment": {
      const p = await pay(String(args.paymentId ?? "")); if (!p) return { error: "Payment not found." };
      if (p.status === "VOIDED") return { error: "That payment is voided." };
      const action = parseAs("edit_payment", { paymentId: p.id, amount: args.amount == null ? null : toMinor(Number(args.amount), p.currency), paymentDate: D(args.paymentDate) ?? null, bankReference: S(args.bankReference)?.slice(0, 120) ?? null, notes: S(args.notes)?.slice(0, 2000) ?? null, eventId: args.eventId === undefined ? undefined : S(args.eventId) ?? null, reason: S(args.reason) ?? "Edited via finance assistant" });
      const changes = [action.amount != null && `amount ${m(p.amount, p.currency)} → ${m(action.amount, p.currency)}`, action.paymentDate && `date → ${action.paymentDate}`, action.bankReference && `reference → ${action.bankReference}`, action.notes && "notes updated", action.eventId !== undefined && "event changed"].filter(Boolean).join(", ");
      return propose(c, `Edit payment ${m(p.amount, p.currency)} to ${await orgName(p.organiserId)} (${p.paymentDate}): ${changes || "no change"} — reason: ${action.reason}`, action, false);
    }
    case "propose_void_payment": {
      const p = await pay(String(args.paymentId ?? "")); if (!p) return { error: "Payment not found." };
      if (p.status === "VOIDED") return { error: "Already voided." };
      const action = parseAs("void_payment", { paymentId: p.id, reason: S(args.reason) ?? "Voided via finance assistant" });
      return propose(c, `Void payment ${m(p.amount, p.currency)} to ${await orgName(p.organiserId)} (${p.paymentDate}, ${p.bankReference ?? "no ref"}) — reason: ${action.reason}`, action, true);
    }
    case "profit_share": {
      const ps = await listPartners(a.orgId);
      const id = S(args.partnerId);
      if (!id) return ps.map((p) => ({ partnerId: p.id, name: p.name, role: p.role, sharePercent: p.shareBps / 100, appliesFrom: p.appliesFrom, lossesCount: p.lossesCount, active: p.active }));
      if (!ps.some((p) => p.id === id)) return { error: "Partner not found — call profit_share without partnerId." };
      const o = await partnerOverview(a.orgId, mode, id);
      return { partner: o.partner.name, sharePercent: o.partner.sharePercent, totals: o.totals.map((x) => ({ currency: x.currency, eventProfit: m(x.profit, x.currency), earned: m(x.earned, x.currency), paid: m(x.paid, x.currency), owed: m(x.owed, x.currency) })),
        monthly: o.monthly.slice(0, 36).map((x) => ({ month: x.month, currency: x.currency, profit: m(x.profit, x.currency), share: m(x.share, x.currency) })),
        events: o.events.slice(0, 80).map((e) => ({ code: e.code, name: e.name, date: e.date, currency: e.currency, profit: m(e.profitBefore, e.currency), share: m(e.share, e.currency) })),
        payments: o.payments.map((p) => ({ date: p.paymentDate, amount: m(p.amount, p.currency), reference: p.bankReference, status: p.status })) };
    }
    case "propose_partner_payment": {
      const ps = await listPartners(a.orgId); const p = ps.find((x) => x.id === S(args.partnerId));
      if (!p) return { error: "Partner not found." };
      const currency = String(args.currency ?? "").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency) || !(Number(args.amount) > 0) || !D(args.paymentDate)) return { error: "Need a valid amount, 3-letter currency and YYYY-MM-DD date." };
      const action = parseAs("partner_payment", { mode, partnerId: p.id, amount: toMinor(Number(args.amount), currency), currency, paymentDate: D(args.paymentDate), method: Method.catch("BANK_TRANSFER").parse(args.method ?? "BANK_TRANSFER"), bankReference: S(args.bankReference)?.slice(0, 120) ?? null, notes: S(args.notes)?.slice(0, 2000) ?? null });
      return propose(c, `Record profit-share payment of ${m(action.amount, currency)} to ${p.name} on ${action.paymentDate}${action.bankReference ? `, ref ${action.bankReference}` : ""} — ${mode.toUpperCase()} books`, action, false);
    }
    case "expense_categories": {
      const rows = await db.select().from(schema.acctAccounts).where(and(eq(schema.acctAccounts.organisationId, a.orgId), eq(schema.acctAccounts.type, "EXPENSE"), eq(schema.acctAccounts.active, true)));
      return rows.filter((x) => !["stripe_fees", "stripe_fee_recharges", "refunds", "chargebacks", "wages", "employer_payroll_costs"].includes(x.systemKey ?? "")).map((x) => ({ accountId: x.id, code: x.code, name: x.name }));
    }
    case "propose_record_expense": {
      const currency = String(args.currency ?? "").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency) || !(Number(args.total) > 0) || !D(args.date) || !S(args.supplierName)) return { error: "Need supplier, total, 3-letter currency and YYYY-MM-DD date." };
      const [acc] = await db.select().from(schema.acctAccounts).where(and(eq(schema.acctAccounts.id, String(args.accountId ?? "")), eq(schema.acctAccounts.organisationId, a.orgId), eq(schema.acctAccounts.type, "EXPENSE")));
      if (!acc) return { error: "Unknown expense category — call expense_categories first." };
      const total = toMinor(Number(args.total), currency), vat = args.vat ? toMinor(Number(args.vat), currency) : 0;
      if (vat > total) return { error: "VAT cannot exceed the total." };
      const action = parseAs("record_expense", { mode, docKind: args.docKind === "BILL" ? "BILL" : "EXPENSE", supplierName: S(args.supplierName)!.slice(0, 200), invoiceNumber: S(args.invoiceNumber)?.slice(0, 80) ?? null, date: D(args.date), currency, netAmount: total - vat, vatAmount: vat, accountId: acc.id, eventId: S(args.eventId) ?? null, description: S(args.description)?.slice(0, 2000) ?? null, paidFrom: ["BANK", "CARD", "CASH", "EMPLOYEE"].includes(String(args.paidFrom)) ? args.paidFrom : "BANK", paymentReference: S(args.bankReference)?.slice(0, 120) ?? null });
      return propose(c, `Book ${action.docKind === "BILL" ? "supplier invoice (paid)" : "expense"}: ${action.supplierName} ${m(total, currency)}${vat ? ` incl. VAT ${m(vat, currency)}` : ""} on ${action.date}, category ${acc.code} ${acc.name}${action.paymentReference ? `, ref ${action.paymentReference}` : ""} — ${mode.toUpperCase()} books`, action, false);
    }
    case "propose_wise_ignore": {
      const [t] = await db.select().from(schema.acctWiseTransactions).where(and(eq(schema.acctWiseTransactions.id, String(args.wiseTransactionId ?? "")), eq(schema.acctWiseTransactions.organisationId, a.orgId)));
      if (!t) return { error: "Wise transaction not found." };
      const action = parseAs("wise_ignore", { wiseTransactionId: t.id, reason: S(args.reason) ?? "Not an organiser payment" });
      return propose(c, `Mark Wise ${t.wiseId.split(":")[0]} (${m(t.amount, t.currency)} to ${t.counterparty ?? "?"}) as not an organiser payment — ${action.reason}`, action, false);
    }
    default: return { error: `Unknown tool ${name}` };
  }
}

function propose(c: Ctx, summary: string, action: AgentActionT, needsElevation: boolean) {
  const id = `P${c.proposals.length + 1}`;
  c.proposals.push({ id, summary, action, needsElevation });
  return { proposal: id, summary, status: "WAITING FOR THE ADMIN TO CONFIRM — not done yet" };
}

// ---------- LLM (injectable for tests) ----------
type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; tool_call_id?: string };
type Llm = (a: { apiKey: string; model: string; messages: Msg[]; tools: typeof TOOLS }) => Promise<{ message: Msg; tokens?: number }>;
const g = globalThis as { __agentLlm?: Llm };
export const setAgentLlm = (f: Llm | null) => { g.__agentLlm = f ?? undefined; };
const openAi: Llm = async ({ apiKey, model, messages, tools }) => {
  const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(120_000), headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages, tools, tool_choice: "auto", parallel_tool_calls: true }) });
  const body = await res.json().catch(() => null) as { choices?: Array<{ message?: Msg }>; usage?: { total_tokens?: number }; error?: { message?: string } } | null;
  if (!res.ok) throw new AppError("invalid_state", `OpenAI: ${body?.error?.message ?? `HTTP ${res.status}`}`.replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-…").slice(0, 400));
  return { message: body?.choices?.[0]?.message ?? { role: "assistant", content: "" }, tokens: body?.usage?.total_tokens };
};

const STEP_LABEL: Record<string, string> = { profit_share: "profit share", expense_categories: "expense categories", search_organisers: "organisers", organiser_account: "organiser account", list_events: "events", list_payments: "payments", wise_transactions: "Wise transactions", wise_status: "Wise balances", sync_wise: "synced Wise", stripe_payouts: "Stripe payouts", stripe_transactions: "Stripe transactions", books_overview: "books overview", health_checks: "bookkeeping checks" };

export async function runAgentChat(a: Actor, mode: Mode, input: z.infer<typeof AgentChatInput>) {
  const cfg = await aiConfig(a.orgId);
  const { timezone } = await getAcctSettings(a.orgId);
  const today = localDate(new Date(), timezone || "UTC");
  const c: Ctx = { a, mode, proposals: [], m: (v, cur) => formatMoney(v, cur, "en") };
  const messages: Msg[] = [
    { role: "system", content: `${AGENT_SYSTEM}${cfg.instructions ? `\n\nStanding instructions from the finance admin:\n${cfg.instructions}` : ""}\n\nToday is ${today} (${timezone || "UTC"}). You are working in the ${mode.toUpperCase()} books.` },
    ...input.messages.map((x) => ({ role: x.role, content: x.content }) as Msg),
  ];
  const steps: string[] = []; let tokens = 0;
  const llm = g.__agentLlm ?? openAi;
  for (let i = 0; i < 10; i++) {
    const { message, tokens: t } = await llm({ apiKey: cfg.apiKey, model: cfg.model, messages, tools: TOOLS });
    tokens += t ?? 0;
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    if (!message.tool_calls?.length) {
      await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_agent.asked", entity: "ai_agent", entityId: "chat", new: { question: input.messages[input.messages.length - 1]!.content.slice(0, 500), steps, proposals: c.proposals.map((p) => p.summary), model: cfg.model, tokens } }));
      return { answer: (message.content ?? "").trim() || "(no answer)", steps: [...new Set(steps)], proposals: c.proposals, model: cfg.model };
    }
    for (const call of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* bad JSON from the model */ }
      let out: unknown;
      try { out = await runTool(c, call.function.name, args); }
      catch (e) { out = { error: e instanceof Error ? e.message.slice(0, 300) : "failed" }; log.warn("accounting.agent_tool_failed", { tool: call.function.name, error: String(e).slice(0, 300) }); }
      if (STEP_LABEL[call.function.name]) steps.push(STEP_LABEL[call.function.name]!);
      messages.push({ role: "tool", tool_call_id: call.id, content: cap(out) });
    }
  }
  return { answer: "I looked at a lot of data but could not finish — please narrow the question.", steps: [...new Set(steps)], proposals: c.proposals, model: cfg.model };
}

/** Run a proposal the admin confirmed. Same functions, permissions and audit as the normal screens. */
export async function executeAction(a: Actor, action: AgentActionT) {
  switch (action.kind) {
    case "record_payment": { const { kind: _k, ...rest } = action; void _k; return { done: "Payment recorded", result: await recordOrganiserPayment(a, rest) }; }
    case "mark_paid": {
      let r = await markPaymentPaid(a, action.paymentId, action.paymentDate ?? undefined);
      if (action.bankReference) r = await editOrganiserPayment(a, action.paymentId, { bankReference: action.bankReference, reason: "Bank reference added when marked paid" });
      return { done: "Payment marked as paid", result: r };
    }
    case "edit_payment": return { done: "Payment updated", result: await editOrganiserPayment(a, action.paymentId, { ...(action.amount != null ? { amount: action.amount } : {}), ...(action.paymentDate ? { paymentDate: action.paymentDate } : {}), ...(action.bankReference ? { bankReference: action.bankReference } : {}), ...(action.notes ? { notes: action.notes } : {}), ...(action.eventId !== undefined ? { eventId: action.eventId } : {}), reason: action.reason }) };
    case "void_payment": return { done: "Payment voided", result: await voidOrganiserPayment(a, action.paymentId, action.reason) };
    case "partner_payment": { const { kind: _k2, ...rest } = action; void _k2; return { done: "Partner payment recorded", result: await recordPartnerPayment(a, rest) }; }
    case "record_expense": {
      const r = await createBill(a, { mode: action.mode, kind: action.docKind, supplierName: action.supplierName, supplierVat: null, country: null, invoiceNumber: action.invoiceNumber, invoiceDate: action.date, dueDate: null, currency: action.currency, netAmount: action.netAmount, vatAmount: action.vatAmount, accountId: action.accountId, eventId: action.eventId, description: action.description, paidFrom: action.paidFrom, paidDate: action.docKind === "BILL" ? action.date : null, paymentReference: action.paymentReference });
      return { done: action.docKind === "BILL" ? "Supplier invoice booked (paid)" : "Expense booked", result: r };
    }
    case "wise_ignore": return { done: "Wise transfer marked as not an organiser payment", result: await setWiseIgnored(a, action.wiseTransactionId, { ignored: true, reason: action.reason }) };
  }
}
