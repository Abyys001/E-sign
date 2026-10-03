import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatMoney } from "@/lib/money";
import type { RequestContext } from "../audit";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import { log } from "../logger";
import { accountantData, type AccountantData, type Range } from "./accountant";
import { acctAudit, getAcctSettings, isLive, type Mode } from "./core";

/**
 * AI bookkeeping review with OpenAI. The model receives an aggregated, anonymised digest of the period (totals per
 * currency, per event and per category, the automated checks) — never customer names, emails or card data, and
 * employees only by their employee number. It answers in a fixed JSON shape that the dashboard and the accountant
 * report display. The API key is stored encrypted and is never returned by any endpoint.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const AiSettingsInput = z.object({
  enabled: z.boolean().default(false),
  model: z.string().trim().min(2, "Enter a model name, e.g. gpt-4.1").max(80).regex(/^[A-Za-z0-9._:/-]+$/, "Model names contain only letters, digits and . _ : - /").default("gpt-4.1"),
  // Pasted keys often carry quotes, spaces or invisible characters; strip them before checking.
  apiKey: z.preprocess((v) => (typeof v === "string" ? v.replace(/[\s"'`\u200B-\u200D\uFEFF]/g, "") : v),
    z.string().min(20, "That does not look like a complete OpenAI API key").max(500).regex(/^[A-Za-z0-9_\-.:]+$/, "The API key contains characters an OpenAI key never has").optional().nullable()), // only sent when it changes; null removes it
  instructions: z.string().trim().max(4000).optional().nullable(),
});
type Stored = { enabled?: boolean; model?: string; apiKeyEnc?: string | null; keyHint?: string | null; instructions?: string | null };

async function stored(orgId: string): Promise<Stored> {
  await getAcctSettings(orgId);
  const [s] = await db.select({ v: schema.acctSettings.aiSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  return (s?.v ?? {}) as Stored;
}

export async function getAiSettings(orgId: string) {
  const s = await stored(orgId);
  return { enabled: !!s.enabled, model: s.model ?? "gpt-4.1", hasKey: !!s.apiKeyEnc, keyHint: s.keyHint ?? null, instructions: s.instructions ?? "", systemPrompt: SYSTEM_PROMPT };
}

export async function updateAiSettings(a: Actor, input: z.infer<typeof AiSettingsInput>) {
  const s = await stored(a.orgId);
  const next: Stored = { enabled: input.enabled, model: input.model, instructions: input.instructions ?? null, apiKeyEnc: s.apiKeyEnc ?? null, keyHint: s.keyHint ?? null };
  if (input.apiKey === null) { next.apiKeyEnc = null; next.keyHint = null; }
  else if (input.apiKey) { next.apiKeyEnc = encrypt(input.apiKey); next.keyHint = `${input.apiKey.slice(0, 7)}…${input.apiKey.slice(-4)}`; }
  if (next.enabled && !next.apiKeyEnc) throw new AppError("validation_failed", "Add an OpenAI API key to enable the AI review.", [{ path: "apiKey", message: "Paste your OpenAI API key to enable the review" }]);
  // Check the key and model with OpenAI before saving, so mistakes show up here rather than on the first review.
  if (next.enabled && next.apiKeyEnc && (input.apiKey || next.model !== s.model || !s.enabled)) await (g.__aiChecker ?? checkOpenAi)(decrypt(next.apiKeyEnc), next.model!);
  await db.transaction(async (tx) => {
    await tx.update(schema.acctSettings).set({ aiSettings: next, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: "ai_settings.updated", entity: "settings", entityId: "ai", old: { enabled: !!s.enabled, model: s.model, keyHint: s.keyHint }, new: { enabled: next.enabled, model: next.model, keyHint: next.keyHint, keyChanged: input.apiKey !== undefined } });
  });
  return getAiSettings(a.orgId);
}

// ---------- prompt ----------
export const SYSTEM_PROMPT = `You are a senior chartered accountant and professional bookkeeper reviewing the books of an online event-ticketing platform ("Bilit"). You are thorough, sceptical and practical. You write for the company's finance admin and its external accountant.

HOW THE BUSINESS WORKS (use this to judge whether the books make sense):
- Customers buy tickets through Stripe. The checkout price = ticket price + a booking fee added on top (e.g. €35 ticket + 10% = €38.50 paid; the booking fee is €3.50).
- Bilit sells tickets as an AGENT for event organisers. The ticket price belongs to the organiser; Bilit's revenue is the booking fee (plus any fixed event fees and other revenue). The booking fee % can differ per event and can change over time.
- Platform policy: the booking fee is NON-REFUNDABLE. If a customer is refunded only the ticket price, Bilit keeps the fee. If the booking fee is refunded too, that amount is charged back to the organiser ("booking fee to recover from organiser").
- Stripe fees are borne by Bilit or by the organiser, depending on the event agreement.
- Organiser settlement: amount due to organiser = net ticket sales − booking fee − recharged Stripe fees − deductions; Bilit pays organisers by bank transfer; remaining = due − paid. Negative remaining means the organiser owes Bilit money.
- Bilit also has its own costs: supplier invoices (bills, owed until paid), expenses (already paid), event platform costs, and payroll (payslips with hand-entered tax/social/pension deductions and employer contributions).
- VAT: output VAT is contained in the booking fee (VAT-inclusive at a configured rate); ticket money is outside Bilit's VAT as agent unless configured otherwise. Input VAT comes from supplier invoices with a valid supplier VAT number.
- Bookkeeping is double-entry, append-only (corrections are reversals), per currency (currencies are never added together). "Unallocated Stripe Receipts" and the suspense account should normally be zero.

YOUR TASK
Review the period digest you are given (JSON). Look for:
1. Gaps and missing records: unmatched sales, unallocated money, missing receipts/invoices, supplier VAT numbers missing, events without organisers, payroll taxes not paid over, payslips not paid, payments pending too long.
2. Things that do not add up or look unusual: negative balances, organisers overpaid or owing money, refund rates that look high, booking-fee income inconsistent with the booking-fee % and gross sales, Stripe fees out of line (typically ~1.5%–3.5% of gross), profit margins that are negative or implausible, large or round-number manual entries, costs with no category logic, payouts not reconciled, VAT position inconsistent.
3. Settlement risk: organisers with large remaining balances after their event date, overpayments, booking fees to recover.
4. Compliance and good practice: VAT invoice evidence, period close, segregation of test/live data, documentation an accountant or tax authority would expect.
Quote concrete figures (with currency) from the digest. Do not invent numbers or facts that are not in the digest; if information is missing say what you would need. Never give legal certainty — flag items to confirm with the company's accountant. Prefer specific, actionable recommendations (what to do, where in the system).

OUTPUT: return ONLY a JSON object with exactly this shape:
{
  "overallStatus": "good" | "needs_attention" | "serious_issues",
  "summary": "4–8 sentence plain-English summary of the state of the books for the period",
  "findings": [ { "severity": "high" | "medium" | "low", "area": "sales" | "refunds" | "organisers" | "expenses" | "payroll" | "vat" | "stripe" | "ledger" | "other", "title": "short title", "detail": "what you found, with figures", "recommendation": "what to do next", "currency": "eur" | null, "amount": number | null } ],
  "questionsForAccountant": [ "specific question the external accountant should answer" ],
  "goodPractice": [ "things that are in good order" ]
}
Amounts in "amount" are in major units (e.g. 12.50). Order findings by severity (high first). Keep it professional and concise.`;

/** Anonymised digest of the period for the model (no customer PII). */
export function digest(d: AccountantData) {
  const m = (v: number, c: string) => formatMoney(v, c, "en");
  return {
    period: d.range, dataMode: d.mode, currenciesNeverMixed: true,
    profitAndLoss: d.books.map((c) => ({ currency: c.currency, income: m(c.revenue, c.currency), costs: m(c.expenses, c.currency), netProfit: m(c.netProfit, c.currency), byAccount: c.lines.map((l) => ({ account: `${l.code} ${l.name}`, type: l.type, amount: m(l.amount, c.currency) })),
      unpaidSupplierInvoices: m(c.unpaidBills, c.currency), overdueSupplierInvoices: `${m(c.overdueBills, c.currency)} (${c.overdueCount})`, inputVat: m(c.inputVat, c.currency), payroll: { gross: m(c.payroll.gross, c.currency), net: m(c.payroll.net, c.currency), employerCosts: m(c.payroll.employer, c.currency), payslips: c.payroll.payslips } })),
    vat: d.vat.map((v) => ({ currency: v.currency, bookingFeesInclVat: m(v.bookingFees, v.currency), ratePercent: v.rateBps / 100, outputVat: m(v.outputVat, v.currency), inputVat: m(v.inputVat, v.currency), netVatPayable: m(v.netVatPayable, v.currency) })),
    eventTotals: d.eventTotals.map((t) => ({ currency: t.currency, tickets: t.tickets, gross: m(t.grossSales, t.currency), refunds: m(t.refunds, t.currency), chargebacks: m(t.chargebacks, t.currency), bookingFees: m(t.bookingFees, t.currency), stripeFees: m(t.processingFees, t.currency), stripeFeesRecharged: m(t.feesRecharged, t.currency), bookingFeeToRecover: m(t.bookingFeesRefunded, t.currency), organiserDue: m(t.organiserDue, t.currency), organiserPaid: m(t.organiserPaid, t.currency), remaining: m(t.remaining, t.currency), bilitProfit: m(t.bilitProfit, t.currency) })),
    events: d.events.filter((e) => e.grossSales || e.organiserDue || e.organiserPaid).slice(0, 80).map((e) => ({ event: `${e.eventName} (${e.eventCode})`, date: e.startsOn, organiser: e.organiserName, status: e.eventStatus, currency: e.currency, tickets: e.tickets, bookingFeePercent: (e.bookingFeeBps ?? 0) / 100, stripeFeesBorneBy: e.stripeFeesBorneBy, gross: m(e.grossSales, e.currency), refunds: m(e.refunds + e.chargebacks, e.currency), bookingFees: m(e.bookingFees, e.currency), stripeFees: m(e.processingFees, e.currency), platformExpenses: m(e.expensesBilit, e.currency), organiserDue: m(e.organiserDue, e.currency), paid: m(e.organiserPaid, e.currency), remaining: m(e.remaining, e.currency), settlement: e.settlement, bilitProfit: m(e.bilitProfit, e.currency) })),
    organiserPayments: { count: d.payments.length, byStatus: count(d.payments.map((p) => String(p.status))), byMethod: count(d.payments.map((p) => String(p.method))) },
    supplierInvoicesAndExpenses: { count: d.bills.length, withoutDocument: d.bills.filter((b) => !b.has_document && b.status !== "VOIDED").length, byCategory: sumBy(d.bills.filter((b) => b.status !== "VOIDED"), (b) => `${b.account} (${String(b.currency).toUpperCase()})`, (b) => Number(b.total_amount)) },
    eventPlatformExpenses: { count: d.expenses.length, withoutReceipt: d.expenses.filter((x) => !x.has_receipt && x.status !== "VOIDED").length },
    payroll: d.payslips.map((p) => ({ employeeRef: p.employee_ref ?? "n/a", country: p.country, payDate: p.pay_date, gross: m(Number(p.gross_pay), String(p.currency)), deductions: m(Number(p.total_deductions), String(p.currency)), net: m(Number(p.net_pay), String(p.currency)), employer: m(Number(p.employer_total), String(p.currency)), status: p.status })),
    refunds: { count: d.refunds.length, byStatus: count(d.refunds.map((r) => String(r.status))), bookingFeeKept: d.refunds.filter((r) => r.keep_booking_fee || !Number(r.commission_reversed)).length },
    stripePayouts: { count: d.payouts.length, byStatus: count(d.payouts.map((p) => String(p.status))), notReconciled: d.payouts.filter((p) => p.reconciliation_status !== "MATCHED").length },
    customerInvoices: { issued: d.customerInvoices.filter((i) => i.status === "ISSUED").length, vatInvoices: d.customerInvoices.filter((i) => i.vat_invoice).length, creditNotes: d.customerInvoices.filter((i) => i.kind === "CREDIT_NOTE").length },
    trialBalance: d.trialBalance.filter((x) => x.balance !== 0).map((x) => ({ currency: x.currency, account: `${x.code} ${x.name}`, type: x.type, balance: m(x.balance, x.currency) })),
    automatedChecks: d.checks.map((c) => ({ severity: c.severity, check: c.title, count: c.count, amounts: Object.entries(c.amounts ?? {}).map(([k, v]) => m(v, k)), guidance: c.detail })),
    ledgerEntriesInPeriod: d.ledger.length,
  };
}
const count = (xs: string[]) => xs.reduce<Record<string, number>>((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {});
function sumBy<T>(xs: T[], key: (x: T) => string, val: (x: T) => number) { const o: Record<string, number> = {}; for (const x of xs) o[key(x)] = (o[key(x)] ?? 0) + val(x); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (v / 100).toFixed(2)])); }

export const ReviewResult = z.object({
  overallStatus: z.enum(["good", "needs_attention", "serious_issues"]),
  summary: z.string().max(5000),
  findings: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), area: z.string().max(40), title: z.string().max(300), detail: z.string().max(3000), recommendation: z.string().max(2000), currency: z.string().max(3).nullable().optional(), amount: z.number().nullable().optional() })).max(60),
  questionsForAccountant: z.array(z.string().max(1000)).max(30).default([]),
  goodPractice: z.array(z.string().max(1000)).max(30).default([]),
});

/** Injected in tests; production calls the OpenAI Chat Completions API. */
type Completer = (a: { apiKey: string; model: string; system: string; user: string }) => Promise<{ content: string; promptTokens?: number; completionTokens?: number }>;
const g = globalThis as { __aiCompleter?: Completer; __aiChecker?: (apiKey: string, model: string) => Promise<void> };
export const setAiCompleter = (f: Completer | null) => { g.__aiCompleter = f ?? undefined; };
type Checker = (apiKey: string, model: string) => Promise<void>;
export const setAiChecker = (f: Checker | null) => { g.__aiChecker = f ?? undefined; };

/**
 * Check the key the same way the review uses it: a one-token chat completion. (Listing models needs a permission many
 * restricted keys do not have, so it would reject keys that work fine.) OpenAI's own message is shown on failure.
 */
const checkOpenAi: Checker = async (apiKey, model) => {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with: ok" }], max_completion_tokens: 16 }),
    });
  } catch { throw new AppError("invalid_state", "Could not reach OpenAI to check the key. Try again in a moment."); }
  if (res.ok) return;
  const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string; type?: string } } | null;
  const said = (body?.error?.message ?? "").replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-…").slice(0, 300);
  const code = body?.error?.code ?? "";
  if (res.status === 401 && /insufficient permissions|missing scopes/i.test(said)) throw new AppError("validation_failed", `This key is restricted and may not create chat completions. In OpenAI → API keys, edit the key and allow “Model capabilities” (or use “All”). OpenAI: ${said}`, [{ path: "apiKey", message: "Key lacks the chat-completions permission" }]);
  if (res.status === 401) throw new AppError("validation_failed", `OpenAI rejected this API key. OpenAI: ${said || "invalid key"}`, [{ path: "apiKey", message: "Invalid, revoked or incompletely copied key" }]);
  if (res.status === 403) throw new AppError("validation_failed", `OpenAI refused access. OpenAI: ${said}`, [{ path: "apiKey", message: "Key/project not allowed (permissions, region or organisation)" }]);
  if (res.status === 404 || code === "model_not_found") throw new AppError("validation_failed", `Your OpenAI account cannot use the model “${model}”. OpenAI: ${said}`, [{ path: "model", message: "Model not available for this key — try gpt-4o-mini or gpt-4o" }]);
  if (res.status === 429) throw new AppError("validation_failed", `OpenAI: ${said || "rate limit or no credit"}`, [{ path: "apiKey", message: code === "insufficient_quota" ? "No credit — add billing to your OpenAI account" : "Rate limited — try again shortly" }]);
  if (res.status === 400) throw new AppError("validation_failed", `OpenAI did not accept the test request. OpenAI: ${said}`, [{ path: "model", message: "Check the model name" }]);
  throw new AppError("invalid_state", `OpenAI check failed (HTTP ${res.status}). ${said}`);
};

const openAiCompleter: Completer = async ({ apiKey, model, system, user }) => {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" } }),
  });
  const body = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } } | null;
  if (!res.ok) throw new AppError("invalid_state", `OpenAI: ${body?.error?.message ?? `HTTP ${res.status}`}`.slice(0, 400));
  return { content: body?.choices?.[0]?.message?.content ?? "", promptTokens: body?.usage?.prompt_tokens, completionTokens: body?.usage?.completion_tokens };
};

export async function runAiReview(a: Actor, mode: Mode, range: Range) {
  const s = await stored(a.orgId);
  if (!s.enabled || !s.apiKeyEnc) throw new AppError("invalid_state", "Enable the AI review and add an OpenAI API key under Finance settings → AI accountant.");
  const model = s.model ?? "gpt-4.1";
  const data = await accountantData(a.orgId, mode, range);
  const user = `${s.instructions ? `Additional instructions from the finance admin:\n${s.instructions}\n\n` : ""}Period digest (JSON):\n${JSON.stringify(digest(data))}`;
  let status = "SUCCEEDED", result: z.infer<typeof ReviewResult> | null = null, error: string | null = null, tokens: { p?: number; c?: number } = {};
  try {
    const out = await (g.__aiCompleter ?? openAiCompleter)({ apiKey: decrypt(s.apiKeyEnc), model, system: SYSTEM_PROMPT, user });
    tokens = { p: out.promptTokens, c: out.completionTokens };
    const parsed = ReviewResult.safeParse(JSON.parse(out.content));
    if (!parsed.success) throw new AppError("invalid_state", "The AI answer was not in the expected format. Try again or use a stronger model.");
    result = parsed.data;
  } catch (e) {
    status = "FAILED"; error = (e instanceof Error ? e.message : String(e)).replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]").slice(0, 500);
    log.warn("accounting.ai_review_failed", { orgId: a.orgId, error });
  }
  const [row] = await db.insert(schema.acctAiReviews).values({ organisationId: a.orgId, livemode: isLive(mode), rangeFrom: range.from, rangeTo: range.to, model, status, result, error, promptTokens: tokens.p ?? null, completionTokens: tokens.c ?? null, createdBy: a.userId }).returning();
  await db.transaction((tx) => acctAudit(tx, { ...a, action: "ai_review.run", entity: "ai_review", entityId: row!.id, new: { status, model, range, findings: result?.findings.length ?? 0 } }));
  if (status === "FAILED") throw new AppError("invalid_state", error ?? "AI review failed");
  return row!;
}

export async function listAiReviews(orgId: string, limit = 20) {
  return db.select({ r: schema.acctAiReviews, userName: schema.users.name }).from(schema.acctAiReviews).leftJoin(schema.users, eq(schema.users.id, schema.acctAiReviews.createdBy))
    .where(eq(schema.acctAiReviews.organisationId, orgId)).orderBy(desc(schema.acctAiReviews.createdAt)).limit(limit).then((rows) => rows.map((x) => ({ ...x.r, userName: x.userName })));
}

export async function latestAiSummary(orgId: string, mode: Mode, range: Range) {
  const [r] = await db.select().from(schema.acctAiReviews).where(and(eq(schema.acctAiReviews.organisationId, orgId), eq(schema.acctAiReviews.livemode, isLive(mode)), eq(schema.acctAiReviews.status, "SUCCEEDED"), eq(schema.acctAiReviews.rangeFrom, range.from), eq(schema.acctAiReviews.rangeTo, range.to))).orderBy(desc(schema.acctAiReviews.createdAt)).limit(1);
  const res = r?.result as z.infer<typeof ReviewResult> | undefined;
  if (!res) return null;
  return [`Status: ${res.overallStatus.replace("_", " ")}. ${res.summary}`, ...res.findings.slice(0, 12).map((f) => `• [${f.severity.toUpperCase()}] ${f.title} — ${f.recommendation}`)].join("\n");
}
