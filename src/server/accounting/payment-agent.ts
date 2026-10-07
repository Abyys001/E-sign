import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { currencyExponent, formatMoney, parseMajor } from "@/lib/money";
import type { RequestContext } from "../audit";
import { decrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { aiConfig, completeJson } from "./ai";
import { acctAudit, getAcctSettings, isLive, localDate, type Mode } from "./core";
import { eventFinancials, organiserBalances } from "./finance";

/**
 * AI payment agent: the finance admin pastes or types an instruction ("paid Demian €8,000 by Wise yesterday, ref
 * #2372969752", a bank/Wise confirmation, a WhatsApp message…) and the model, acting as the company's bookkeeper, turns
 * it into organiser-payment proposals. Nothing is posted here: every proposal is checked against the books
 * (organiser/event exist, currency, balance before/after, possible duplicates) and the admin confirms each one, which
 * then goes through the normal recordOrganiserPayment path (own ledger entry, audit).
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const AgentInput = z.object({
  text: z.string().trim().min(3, "Paste or type the payment details").max(8000, "That is too long — paste only the payment part (max 8,000 characters)"),
  organiserId: z.string().uuid().optional().nullable(), // when opened from an organiser's page
});

export const AGENT_PROMPT = `You are the senior bookkeeper / chartered accountant of Bilit, an online event-ticketing platform that sells tickets as AGENT for event organisers and pays the ticket money on to them. The finance admin gives you an instruction, or pastes a bank / Wise / Revolut / Stripe confirmation, an email or a chat message, about money Bilit PAID (or is about to pay) to one or more organisers. Your job is to turn it into accurate organiser-payment records, exactly as a careful real accountant would before posting to the ledger.

HOW TO WORK
1. Read the text carefully. Identify every separate payment in it (one transfer = one record). Ignore anything that is not a payment from Bilit to an organiser (e.g. ticket sales, refunds to customers, money received from an organiser) — mention it in "warnings" instead.
2. Organiser: match against the ORGANISERS list by name, company name, bank account holder, email or internal reference (allow for spelling variants, initials, transliterations, Persian/Arabic/Latin forms). Use only an id from the list. If you are not sure, set organiserId to null, put your best guess in organiserGuess and ask in "questions". Never invent an organiser.
3. Amount and currency: the amount the organiser was paid (the amount sent to them), in major units (8000.00 = eight thousand). Understand formats like "8.000,00 €", "€8k", "8,000 EUR", "kr 12 500", "£1.2k". If the text shows a transfer fee charged to Bilit, the fee is NOT part of the organiser payment — record the amount sent and mention the fee in notes. If a conversion happened (e.g. GBP debited, EUR received), record the currency the organiser's balance is in (check their BALANCES) and note the other side in notes. Never add different currencies together.
4. Date: the date the money left Bilit's account. Resolve relative dates ("yesterday", "last Friday", "15/9") using TODAY. European day-first dates unless clearly otherwise. If no date is given, use TODAY and say so in "warnings".
5. Method: Wise, Revolut, SEPA, IBAN, bank, "transfer" → BANK_TRANSFER; a Stripe payout/transfer id (po_…, tr_…) or "via Stripe" → STRIPE_TRANSFER; cash → CASH; else OTHER. Status: PAID if the money has been sent; PENDING if it is scheduled / to be paid / "please pay".
6. Reference: the transfer id / bank reference exactly as written (e.g. "Wise #2372969752", "po_1ULQJf…"). null if none.
7. Event: company policy is to record a payment as made, against the organiser as a whole (eventId null = paid towards the total payable), and NOT to split it across events. Only set eventId when the text clearly says the payment is for one specific event (by name, city or code) and that event belongs to the same organiser and currency.
8. Check it like an accountant, using BALANCES, EVENTS and RECENT PAYMENTS: does the amount exceed what is still owed (overpayment)? Does the organiser owe Bilit instead? Is there already a payment with the same amount, date or reference (possible duplicate)? Is the currency one the organiser has a balance in? Is the date in the future or very old? Put each concern in "warnings" with the figures.
9. Notes: a short professional narrative for the ledger, e.g. "Settlement payment for Blood In Blood Out tour (Frankfurt/Berlin) — Wise transfer, fee €4.12 borne by Bilit". Keep the admin's own wording for context where useful. No customer personal data.

OUTPUT — return ONLY a JSON object with exactly this shape:
{
  "understanding": "one or two sentences restating what you understood, as an accountant would confirm it back",
  "payments": [ { "organiserId": "uuid from ORGANISERS" | null, "organiserGuess": "name as written" | null, "eventId": "uuid from EVENTS" | null, "amount": 8000.00, "currency": "eur", "paymentDate": "YYYY-MM-DD", "method": "BANK_TRANSFER" | "STRIPE_TRANSFER" | "CASH" | "OTHER", "status": "PAID" | "PENDING", "bankReference": "string" | null, "notes": "ledger narrative", "confidence": "high" | "medium" | "low", "reasoning": "why you matched this organiser/event/amount" } ],
  "warnings": [ "accounting concerns, with figures" ],
  "questions": [ "what you need the admin to confirm before posting" ],
  "accountantNote": "short professional advice on this posting (e.g. remaining balance after payment, what to reconcile next)"
}
If the text contains no payment at all, return "payments": [] and explain in "understanding". Currency codes are lowercase ISO (eur, gbp, sek, dkk, usd…).`;

const Proposal = z.object({
  organiserId: z.string().nullable().optional(), organiserGuess: z.string().max(200).nullable().optional(), eventId: z.string().nullable().optional(),
  amount: z.coerce.number().nullable().optional(), currency: z.string().max(10).nullable().optional(), paymentDate: z.string().max(20).nullable().optional(),
  method: z.string().max(30).nullable().optional(), status: z.string().max(20).nullable().optional(), bankReference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(), confidence: z.string().max(10).nullable().optional(), reasoning: z.string().max(2000).nullable().optional(),
});
const AgentResult = z.object({
  understanding: z.string().max(3000).default(""),
  payments: z.array(Proposal).max(30).default([]),
  warnings: z.array(z.string().max(1000)).max(30).default([]),
  questions: z.array(z.string().max(1000)).max(30).default([]),
  accountantNote: z.string().max(3000).nullable().optional(),
});

const METHODS = ["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"] as const;
type Issue = { level: "error" | "warn" | "info"; text: string };
export type AgentProposal = {
  organiserId: string | null; organiserName: string | null; organiserGuess: string | null; eventId: string | null; eventLabel: string | null;
  amount: number | null; currency: string; paymentDate: string; method: (typeof METHODS)[number]; status: "PAID" | "PENDING"; bankReference: string | null; notes: string | null;
  confidence: "high" | "medium" | "low"; reasoning: string | null;
  balance: { due: number; paid: number; remaining: number; after: number | null; scope: "organiser" | "event" } | null;
  duplicates: Array<{ id: string; paymentDate: string; amount: number; currency: string; bankReference: string | null; status: string }>;
  issues: Issue[];
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Everything the model may use to identify organisers and check the posting. No ticket-buyer data is included. */
async function agentContext(orgId: string, mode: Mode) {
  const [orgs, balances, events, recent] = await Promise.all([
    db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, orgId)),
    organiserBalances(orgId, mode),
    eventFinancials(orgId, mode),
    db.select().from(schema.acctOrganiserPayments).where(and(eq(schema.acctOrganiserPayments.organisationId, orgId), eq(schema.acctOrganiserPayments.livemode, isLive(mode)), ne(schema.acctOrganiserPayments.status, "VOIDED")))
      .orderBy(desc(schema.acctOrganiserPayments.paymentDate)).limit(400),
  ]);
  const holder = (enc: string | null) => { if (!enc) return null; try { return (JSON.parse(decrypt(enc)) as { accountHolder?: string }).accountHolder ?? null; } catch { return null; } };
  return { orgs, balances, events, recent, holder };
}

export async function analysePaymentText(a: Actor, mode: Mode, input: z.infer<typeof AgentInput>) {
  const cfg = await aiConfig(a.orgId);
  const { timezone } = await getAcctSettings(a.orgId);
  const today = localDate(new Date(), timezone || "UTC");
  const c = await agentContext(a.orgId, mode);
  const m = (v: number, cur: string) => formatMoney(v, cur, "en");
  const orgName = new Map(c.orgs.map((o) => [o.id, o.name]));
  const data = {
    today, weekday: new Date(`${today}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }), dataMode: mode,
    openedFromOrganiser: input.organiserId ? { id: input.organiserId, name: orgName.get(input.organiserId) ?? null } : null,
    ORGANISERS: c.orgs.map((o) => ({ id: o.id, name: o.name, company: o.companyName, accountHolder: c.holder(o.bankDetailsEnc), email: o.email, ref: o.internalRef, active: o.active })),
    BALANCES: c.balances.map((b) => ({ organiserId: b.organiserId, organiser: orgName.get(b.organiserId) ?? null, currency: b.currency, due: m(b.organiserDue, b.currency), paid: m(b.organiserPaid, b.currency), remaining: m(b.remaining, b.currency), pending: m(b.pendingPayments, b.currency), status: b.settlement })),
    EVENTS: c.events.filter((e) => e.organiserId).map((e) => ({ id: e.eventId, code: e.eventCode, name: e.eventName, date: e.startsOn, status: e.eventStatus, organiserId: e.organiserId, currency: e.currency, due: m(e.organiserDue, e.currency), paid: m(e.organiserPaid, e.currency), remaining: m(e.remaining, e.currency) })),
    RECENT_PAYMENTS: c.recent.slice(0, 150).map((p) => ({ organiser: orgName.get(p.organiserId) ?? null, organiserId: p.organiserId, date: p.paymentDate, amount: m(p.amount, p.currency), method: p.method, reference: p.bankReference, status: p.status })),
  };
  const system = `${AGENT_PROMPT}${cfg.instructions ? `\n\nAdditional instructions from the finance admin:\n${cfg.instructions}` : ""}\n\nBOOKS (JSON, ${mode} mode):\n${JSON.stringify(data)}`;
  const user = `Instruction / pasted text from the finance admin:\n"""\n${input.text}\n"""`;
  let out: Awaited<ReturnType<typeof completeJson>>;
  try { out = await completeJson({ apiKey: cfg.apiKey, model: cfg.model, system, user }); }
  catch (e) { const msg = (e instanceof Error ? e.message : String(e)).replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-…"); log.warn("accounting.payment_agent_failed", { orgId: a.orgId, error: msg }); throw e instanceof AppError ? e : new AppError("invalid_state", msg.slice(0, 400)); }
  let raw: unknown;
  try { raw = JSON.parse(out.content); } catch { throw new AppError("invalid_state", "The AI answer was not in the expected format. Try again or use a stronger model."); }
  const parsed = AgentResult.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_state", "The AI answer was not in the expected format. Try again or use a stronger model.");
  const r = parsed.data;

  const proposals = r.payments.map((p): AgentProposal => {
    const issues: Issue[] = [];
    const org = p.organiserId ? c.orgs.find((o) => o.id === p.organiserId) : undefined;
    if (!org) issues.push({ level: "error", text: p.organiserGuess ? `Organiser “${p.organiserGuess}” is not in the organiser list — choose the organiser.` : "Organiser not identified — choose the organiser." });
    else if (!org.active) issues.push({ level: "warn", text: `${org.name} is marked inactive.` });
    let currency = (p.currency ?? "").trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) { issues.push({ level: "error", text: "Currency not recognised — check it." }); currency = "eur"; }
    let amount: number | null = null;
    if (p.amount == null || !Number.isFinite(p.amount) || p.amount <= 0) issues.push({ level: "error", text: "Amount not found — enter it." });
    else { try { amount = parseMajor(p.amount.toFixed(currencyExponent(currency)), currency); } catch { issues.push({ level: "error", text: "Amount not valid." }); } }
    let paymentDate = (p.paymentDate ?? "").trim();
    if (!ISO.test(paymentDate) || Number.isNaN(Date.parse(paymentDate))) { paymentDate = today; issues.push({ level: "warn", text: "No payment date found — today is used." }); }
    else if (paymentDate > today) issues.push({ level: "warn", text: `The date ${paymentDate} is in the future.` });
    else if (paymentDate < addDays(today, -365)) issues.push({ level: "warn", text: `The date ${paymentDate} is more than a year ago — check closed periods.` });
    let eventId: string | null = null, eventLabel: string | null = null;
    if (p.eventId) {
      const ev = c.events.find((e) => e.eventId === p.eventId);
      if (!ev || !org || ev.organiserId !== org.id) issues.push({ level: "warn", text: "The suggested event does not belong to this organiser — recorded against the organiser instead." });
      else if (ev.eventCurrency !== currency) issues.push({ level: "warn", text: `The suggested event is in ${ev.eventCurrency.toUpperCase()} — recorded against the organiser instead.` });
      else { eventId = ev.eventId; eventLabel = `${ev.eventCode} · ${ev.eventName}`; }
    }
    // Balance before / after, at the level the payment is posted (event or whole organiser).
    let balance: AgentProposal["balance"] = null;
    if (org) {
      const b = eventId ? c.events.find((e) => e.eventId === eventId && e.currency === currency) : c.balances.find((x) => x.organiserId === org.id && x.currency === currency);
      if (b) {
        balance = { due: b.organiserDue, paid: b.organiserPaid, remaining: b.remaining, after: amount != null ? b.remaining - amount : null, scope: eventId ? "event" : "organiser" };
        if (b.remaining <= 0) issues.push({ level: "warn", text: b.remaining < 0 ? `${org.name} already owes Bilit ${m(-b.remaining, currency)} — this payment would increase it.` : `Nothing is outstanding for ${org.name} in ${currency.toUpperCase()}.` });
        else if (amount != null && amount > b.remaining) issues.push({ level: "warn", text: `Overpayment: ${m(amount, currency)} exceeds the ${m(b.remaining, currency)} still owed by ${m(amount - b.remaining, currency)}.` });
      } else issues.push({ level: "warn", text: `${org.name} has no ${currency.toUpperCase()} balance in the books.` });
    }
    // Possible duplicates: same reference, or same organiser + amount + currency within 3 days.
    const ref = p.bankReference?.trim() || null;
    const norm = (s: string | null) => (s ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const duplicates = c.recent.filter((x) => (ref && norm(x.bankReference) && norm(x.bankReference) === norm(ref))
      || (org && x.organiserId === org.id && x.currency === currency && amount != null && x.amount === amount && x.paymentDate >= addDays(paymentDate, -3) && x.paymentDate <= addDays(paymentDate, 3)))
      .slice(0, 5).map((x) => ({ id: x.id, paymentDate: x.paymentDate, amount: x.amount, currency: x.currency, bankReference: x.bankReference, status: x.status }));
    if (duplicates.length) issues.push({ level: "error", text: `Possible duplicate of a payment already recorded (${duplicates.map((d) => `${d.paymentDate} ${m(d.amount, d.currency)}${d.bankReference ? ` ${d.bankReference}` : ""}`).join("; ")}). Record only if this is a separate transfer.` });
    const method = (METHODS as readonly string[]).includes(String(p.method)) ? p.method as AgentProposal["method"] : "BANK_TRANSFER";
    return {
      organiserId: org?.id ?? null, organiserName: org?.name ?? null, organiserGuess: p.organiserGuess ?? null, eventId, eventLabel,
      amount, currency, paymentDate, method, status: p.status === "PENDING" ? "PENDING" : "PAID", bankReference: ref?.slice(0, 120) ?? null, notes: p.notes?.trim().slice(0, 2000) || null,
      confidence: p.confidence === "high" || p.confidence === "low" ? p.confidence : "medium", reasoning: p.reasoning ?? null, balance, duplicates, issues,
    };
  });
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_payment_agent.analysed", entity: "ai_payment_agent", entityId: "agent", new: { text: input.text.slice(0, 1000), model: cfg.model, proposals: proposals.length, tokens: (out.promptTokens ?? 0) + (out.completionTokens ?? 0) } }));
  return { understanding: r.understanding, accountantNote: r.accountantNote ?? null, warnings: r.warnings, questions: r.questions, proposals, model: cfg.model, mode };
}
