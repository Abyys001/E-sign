import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { encrypt } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { setStripeGatewayFactory, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { createSyncRun, executeRun } from "@/server/accounting/sync";
import { issueRefund, listCharges } from "@/server/accounting/refunds";
import { issueCustomerInvoice, updateInvoiceSettings, voidCustomerInvoice, InvoiceSettings } from "@/server/accounting/invoices";
import { eventFinancials } from "@/server/accounting/finance";
import { trialBalance } from "@/server/accounting/reports";
import { ctxFor, expectPg, makeOrg } from "./helpers";
import { FakeStripe } from "./stripe-fixtures";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeGatewayFactory(null); await stopBoss(); });

let e: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const { org, user } = await makeOrg("Payments Test");
  const fake = new FakeStripe();
  setStripeGatewayFactory(() => fake);
  const [acc] = await db.insert(schema.stripeAccounts).values({ organisationId: org.id, livemode: false, secretKeyEnc: encrypt(`sk_test_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…", status: "CONNECTED" }).returning();
  const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const organiser = await createOrganiser(actor, { name: "Concerts Ltd", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
  const event = await createEvent(actor, { name: "Persian Night", code: `PN-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "eur", organiserId: organiser.id, startsOn: null, status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "ADDED", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
  const s = fake.sale({ amount: 3850, fee: 120, description: `Order (abc123) for event: Persian Night (${event.code})`, metadata: { quantity: "1" }, name: "Ali Rezaei", email: "ali@example.test" });
  const r = await importBalanceTransaction(await importContext(acc as StripeAccountRow, fake), s.bt);
  return { org, user, fake, acc: acc as StripeAccountRow, actor, event, sale: s, saleRow: r.row };
}
beforeAll(async () => { e = await setup(); });
const fig = async () => (await eventFinancials(e.org.id, "test", { eventIds: [e.event.id] }))[0]!;

describe("Stripe payments incl. failed ones", () => {
  it("a sync stores declined payments with their reason", async () => {
    e.fake.failedCharge({ amount: 5000, description: "Order (zzz) declined", name: "Sam" });
    const run = await createSyncRun({ orgId: e.org.id, mode: "test", kind: "FULL" });
    await executeRun(run.id);
    const all = await listCharges(e.org.id, "test", { status: "failed" }, { limit: 10, offset: 0 });
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ status: "failed", failureCode: "card_declined", failureMessage: "Your card was declined." });
    expect((await listCharges(e.org.id, "test", { status: "issues" }, { limit: 10, offset: 0 })).total).toBe(1);
  });
});

describe("refunds from the dashboard", () => {
  it("refunds the ticket price only (keeps the booking fee) and books it at once", async () => {
    const r = await issueRefund(e.actor, e.saleRow.id, { amount: 3500, reason: "requested_by_customer", note: "Customer cannot attend", keepBookingFee: true, requestId: randomUUID() });
    expect(r).toMatchObject({ amount: 3500, remaining: 350 });
    const [ref] = await db.select().from(schema.stripeRefunds).where(eq(schema.stripeRefunds.refundId, r.refundId));
    expect(ref).toMatchObject({ requestedBy: e.user.id, note: "Customer cannot attend" });
    const f = await fig();
    expect(f).toMatchObject({ grossSales: 3850, refunds: 3500, bookingFees: 350, organiserDue: 0 }); // Bilit keeps its €3.50, organiser refunds the €35
    expect((await trialBalance(e.org.id, "test")).reduce((s, x) => s + x.balance, 0)).toBe(0);
  });
  it("the same request id never refunds twice; over-refunds and read-only keys are refused clearly", async () => {
    const id = randomUUID();
    await issueRefund(e.actor, e.saleRow.id, { amount: 100, reason: "requested_by_customer", note: null, keepBookingFee: false, requestId: id });
    await issueRefund(e.actor, e.saleRow.id, { amount: 100, reason: "requested_by_customer", note: null, keepBookingFee: false, requestId: id }).catch(() => null);
    expect([...e.fake.refunds.values()].filter((x) => x.charge === e.sale.charge.id)).toHaveLength(2); // 3500 + 100 once
    await expectPg(issueRefund(e.actor, e.saleRow.id, { amount: 1000, reason: "requested_by_customer", note: null, keepBookingFee: false, requestId: randomUUID() }), /At most 250/);
    e.fake.readOnlyKey = true;
    await expectPg(issueRefund(e.actor, e.saleRow.id, { amount: 10, reason: "requested_by_customer", note: null, keepBookingFee: false, requestId: randomUUID() }), /Refunds: Write/);
    e.fake.readOnlyKey = false;
  });
});

describe("customer invoices, credit notes and VAT invoices", () => {
  it("needs the seller details first", async () => {
    await expectPg(issueCustomerInvoice(e.actor, e.saleRow.id, { vatInvoice: false }), /company name and address/);
  });
  it("invoice: tickets as agent (no VAT) + booking fee with VAT included; numbered; one per sale", async () => {
    await updateInvoiceSettings(e.actor, InvoiceSettings.parse({ legalName: "Bilit Events Ltd", address: "1 High St\nLondon", vatNumber: null, bookingFeeVatBps: 2000 }));
    const inv = await issueCustomerInvoice(e.actor, e.saleRow.id, { vatInvoice: false });
    expect(inv.number).toMatch(/^INV-\d{4}-00001$/);
    expect(inv).toMatchObject({ kind: "INVOICE", grossTotal: 3850, vatTotal: 58, netTotal: 3792 }); // €3.50 fee incl. 20 % VAT = €0.58
    expect((inv.customer as { name: string }).name).toBe("Ali Rezaei");
    await expectPg(issueCustomerInvoice(e.actor, e.saleRow.id, { vatInvoice: false }), /already issued/);
    await expectPg(issueCustomerInvoice(e.actor, e.saleRow.id, { vatInvoice: true, customer: { name: "Ali", company: "Ali Ltd", address: "x", email: null, vatNumber: "GB1", country: "GB" } }), /already issued|VAT number/);
    await voidCustomerInvoice(e.actor, inv.id, "Customer wants a VAT invoice");
    await expectPg(issueCustomerInvoice(e.actor, e.saleRow.id, { vatInvoice: true, customer: { name: "Ali", company: "Ali Ltd", address: "x", email: null, vatNumber: "GB1", country: "GB" } }), /VAT number/);
    await updateInvoiceSettings(e.actor, InvoiceSettings.parse({ legalName: "Bilit Events Ltd", address: "1 High St\nLondon", vatNumber: "GB999999973", bookingFeeVatBps: 2000 }));
    const vat = await issueCustomerInvoice(e.actor, e.saleRow.id, { vatInvoice: true, customer: { name: "Ali Rezaei", company: "Ali Ltd", address: "2 Low St, London", email: null, vatNumber: "GB123456789", country: "GB" } });
    expect(vat).toMatchObject({ number: expect.stringMatching(/-00002$/), vatInvoice: true });
    expect(vat.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("credit note for a refund references the invoice", async () => {
    const [ref] = await db.select().from(schema.stripeBalanceTransactions).where(and(eq(schema.stripeBalanceTransactions.chargeId, e.sale.charge.id), eq(schema.stripeBalanceTransactions.kind, "REFUND"), eq(schema.stripeBalanceTransactions.amount, -3500)));
    const cn = await issueCustomerInvoice(e.actor, ref!.id, { vatInvoice: false });
    expect(cn).toMatchObject({ kind: "CREDIT_NOTE", grossTotal: 3500, vatTotal: 0 }); // ticket-only refund: booking fee kept
    expect(cn.number).toMatch(/^CN-/);
    expect((cn.customer as { relatedNumber: string }).relatedNumber).toMatch(/-00002$/);
  });
});

describe("refund policy: booking fee non-refundable", () => {
  it("a full refund made in Stripe keeps Bilit's fee; the organiser is charged the refunded fee", async () => {
    const x = await setup();
    const ctx = await importContext(x.acc, x.fake);
    await importBalanceTransaction(ctx, x.fake.refund(x.sale.charge, 3850).bt); // refunded outside the app, full amount
    const f = (await eventFinancials(x.org.id, "test", { eventIds: [x.event.id] }))[0]!;
    expect(f).toMatchObject({ grossSales: 3850, refunds: 3850, bookingFees: 350, bookingFeesRefunded: 350, organiserDue: -350, settlement: "ORGANISER_OWES" });
    // Switching the policy re-derives existing refunds: the fee is reversed and nobody owes anything.
    const { updateAcctSettings } = await import("@/server/accounting/core");
    const { repostRefundsForPolicy } = await import("@/server/accounting/manual");
    await db.transaction((tx) => updateAcctSettings(tx, x.org.id, x.user.id, { bookingFeeRefundable: true }, ctxFor()));
    expect((await repostRefundsForPolicy(x.org.id)).reposted).toBe(1);
    const g = (await eventFinancials(x.org.id, "test", { eventIds: [x.event.id] }))[0]!;
    expect(g).toMatchObject({ bookingFees: 0, organiserDue: 0 });
    expect((await trialBalance(x.org.id, "test")).reduce((s, r) => s + r.balance, 0)).toBe(0);
  });
});

describe("accountant pack and AI review", () => {
  it("zip contains the PDF report and all CSVs; checks flag the gaps", async () => {
    const { accountantData, accountantZip } = await import("@/server/accounting/accountant");
    const { unzipSync, strFromU8 } = await import("fflate");
    const d = await accountantData(e.org.id, "test", { from: "2020-01-01", to: "2030-12-31" });
    const files = unzipSync(new Uint8Array(await accountantZip(d)));
    expect(Object.keys(files)).toHaveLength(14);
    expect(strFromU8(files["00_accountant_report.pdf"]!.subarray(0, 5))).toBe("%PDF-");
    expect(strFromU8(files["04_events_settlement.csv"]!)).toContain("Persian Night");
    expect(strFromU8(files["12_general_ledger.csv"]!).split("\r\n").length).toBeGreaterThan(10);
  });
  it("runs the AI review with an anonymised digest and stores the findings", async () => {
    const { setAiCompleter, setAiChecker, updateAiSettings, runAiReview, getAiSettings, AiSettingsInput } = await import("@/server/accounting/ai");
    setAiChecker(async () => {});
    // Pasted keys: quotes, spaces, newlines and zero-width characters are stripped; project keys (sk-proj-…) are accepted.
    expect(AiSettingsInput.parse({ apiKey: ' "sk-proj-Ab_12-cdEFghIJklMNopQR\u200B"\n' }).apiKey).toBe("sk-proj-Ab_12-cdEFghIJklMNopQR");
    expect(AiSettingsInput.safeParse({ apiKey: "short" }).success).toBe(false);
    let sent = "";
    setAiCompleter(async ({ user, system }) => { sent = user; expect(system).toContain("chartered accountant"); return { content: JSON.stringify({ overallStatus: "needs_attention", summary: "Mostly fine.", findings: [{ severity: "high", area: "sales", title: "Unmatched", detail: "x", recommendation: "Create events", currency: "eur", amount: 50 }], questionsForAccountant: [], goodPractice: ["Ledger balanced"] }), promptTokens: 10, completionTokens: 5 }; });
    await expectPg(runAiReview(e.actor, "test", { from: "2020-01-01", to: "2030-12-31" }), /Enable the AI review/);
    await updateAiSettings(e.actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-test1234567890abcdefghijk", instructions: "Focus on VAT." });
    expect(await getAiSettings(e.org.id)).toMatchObject({ enabled: true, hasKey: true, keyHint: "sk-test…hijk" });
    expect(JSON.stringify(await getAiSettings(e.org.id))).not.toContain("1234567890");
    const r = await runAiReview(e.actor, "test", { from: "2020-01-01", to: "2030-12-31" });
    expect(r).toMatchObject({ status: "SUCCEEDED", model: "gpt-4.1" });
    expect(sent).toContain("Focus on VAT.");
    expect(sent).not.toContain("ali@example.test");
    expect(sent).not.toContain("Ali Rezaei");
    // A key/model OpenAI rejects is reported on the field.
    const { AppError } = await import("@/server/errors");
    setAiChecker(async () => { throw new AppError("validation_failed", "OpenAI rejected this API key.", [{ path: "apiKey", message: "invalid" }]); });
    await expectPg(updateAiSettings(e.actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-wrong1234567890abcdefgh", instructions: null }), /rejected/);
    expect(await getAiSettings(e.org.id)).toMatchObject({ keyHint: "sk-test…hijk" }); // the good key is kept
    setAiChecker(null); setAiCompleter(null);
  });
});

describe("refunds overview", () => {
  it("lists refunds with their sale, event link and booking-fee part; groups unlinked ones by code", async () => {
    const x = await setup();
    const ctx = await importContext(x.acc, x.fake);
    await importBalanceTransaction(ctx, x.fake.refund(x.sale.charge, 3850).bt); // full refund incl. €3.50 fee
    const s2 = x.fake.sale({ amount: 2000, fee: 50, description: "Order (q9) for event: Unknown Gig (ZZ-0001), by Someone" });
    await importBalanceTransaction(ctx, s2.bt);
    await importBalanceTransaction(ctx, x.fake.refund(s2.charge, 2000).bt);
    const { refundsOverview } = await import("@/server/accounting/refunds");
    const o = await refundsOverview(x.org.id, "test", {}, { limit: 50, offset: 0 });
    expect(o.total).toBe(2);
    const linked = o.items.find((r) => r.linked)!;
    expect(linked).toMatchObject({ amount: 3850, saleAmount: 3850, saleFee: 350, feeRefunded: 350, eventId: x.event.id });
    expect(o.unlinkedGroups).toEqual([expect.objectContaining({ code: "ZZ-0001", count: 1, amount: 2000, eventName: "Unknown Gig", eventExists: false })]);
    expect((await refundsOverview(x.org.id, "test", { linked: "no" }, { limit: 50, offset: 0 })).total).toBe(1);
  });
});

describe("bulk-linking Stripe payouts to an organiser", () => {
  it("creates one organiser payment per payout, event per currency, skips linked/failed ones", async () => {
    const x = await setup();
    const mk = (id: string, amount: number, currency: string, status = "paid") => ({ organisationId: x.org.id, stripeAccountRef: x.acc.id, livemode: false, payoutId: id, amount, currency, status, stripeCreatedAt: new Date("2026-09-20T10:00:00Z"), arrivalDate: new Date("2026-09-21T10:00:00Z") });
    await db.insert(schema.stripePayouts).values([mk("po_A", 1000, "eur"), mk("po_B", 2000, "eur"), mk("po_C", 3000, "gbp"), mk("po_D", 500, "eur", "failed")]);
    const { linkPayouts } = await import("@/server/accounting/payout-links");
    const r = await linkPayouts(x.actor, "test", { payoutIds: ["po_A", "po_B", "po_C", "po_D"], organiserId: x.event.organiserId!, eventByCurrency: { eur: x.event.id, gbp: null }, notes: null });
    expect(r.created).toBe(3);
    expect(r.skipped).toEqual([{ payoutId: "po_D", reason: "failed" }]);
    const again = await linkPayouts(x.actor, "test", { payoutIds: ["po_A"], organiserId: x.event.organiserId!, eventByCurrency: {}, notes: null });
    expect(again).toMatchObject({ created: 0, skipped: [{ payoutId: "po_A", reason: "already linked" }] });
    const pays = await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.organiserId, x.event.organiserId!));
    expect(pays.map((p) => `${p.bankReference}:${p.amount}:${p.currency}:${p.eventId ? "event" : "none"}:${p.paymentDate}`).sort()).toEqual(["po_A:1000:eur:event:2026-09-21", "po_B:2000:eur:event:2026-09-21", "po_C:3000:gbp:none:2026-09-21"]);
    expect((await trialBalance(x.org.id, "test")).reduce((s, t) => s + t.balance, 0)).toBe(0);
  });
});

describe("AI finance chat", () => {
  it("answers from the ledger digest, sends no customer PII, needs the AI to be enabled", async () => {
    const x = await setup();
    const { runChat, setAiChat, setAiChecker, updateAiSettings } = await import("@/server/accounting/ai");
    await expectPg(runChat(x.actor, "test", { messages: [{ role: "user", content: "How much profit?" }] }), /Set up the AI accountant/);
    setAiChecker(async () => {});
    await updateAiSettings(x.actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-test1234567890abcdefghijk", instructions: null });
    let sys = "";
    setAiChat(async ({ messages }) => { sys = messages[0]!.content; return { content: "Profit is €3.50 on Persian Night." }; });
    const r = await runChat(x.actor, "test", { messages: [{ role: "user", content: "How much profit?" }] });
    expect(r.answer).toContain("€3.50");
    expect(sys).toContain("Persian Night");
    expect(sys).not.toContain("ali@example.test");
    expect(sys).not.toContain("Ali Rezaei");
    setAiChat(null); setAiChecker(null);
  });
});

describe("AI payment agent", () => {
  it("turns pasted text into checked organiser-payment proposals (balance, overpayment, duplicates), never posting by itself", async () => {
    const x = await setup();
    const { setAiCompleter, setAiChecker, updateAiSettings } = await import("@/server/accounting/ai");
    const { analysePaymentText } = await import("@/server/accounting/payment-agent");
    const { recordOrganiserPayment } = await import("@/server/accounting/manual");
    await expectPg(analysePaymentText(x.actor, "test", { text: "paid Concerts 20 euro" }), /Set up the AI accountant/);
    setAiChecker(async () => {});
    await updateAiSettings(x.actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-test1234567890abcdefghijk", instructions: null });
    const [org] = await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, x.org.id));
    let system = "", user = "";
    const answer = (amount: number, ref: string) => JSON.stringify({ understanding: "Bilit paid Concerts Ltd.", accountantNote: "ok", warnings: [], questions: [], payments: [
      { organiserId: org!.id, organiserGuess: "Concerts", eventId: x.event.id, amount, currency: "EUR", paymentDate: "2026-09-15", method: "BANK_TRANSFER", status: "PAID", bankReference: ref, notes: "Settlement", confidence: "high", reasoning: "name" },
      { organiserId: randomUUID(), organiserGuess: "Nobody Promotions", amount: 10, currency: "eur", paymentDate: "yesterday", method: "WIRE", status: "PAID" },
    ] });
    setAiCompleter(async (a) => { system = a.system; user = a.user; return { content: answer(20, "Wise #123") }; });
    const r = await analysePaymentText(x.actor, "test", { text: "Paid Concerts €20 via Wise on 15/9, #123" });
    expect(system).toContain("Concerts Ltd"); expect(system).toContain("senior bookkeeper");
    expect(system).not.toContain("ali@example.test"); expect(system).not.toContain("Ali Rezaei");
    expect(user).toContain("#123");
    expect(r.proposals[0]).toMatchObject({ organiserId: org!.id, eventId: x.event.id, amount: 2000, currency: "eur", paymentDate: "2026-09-15", balance: { remaining: 3500, after: 1500, scope: "event" }, duplicates: [] });
    expect(r.proposals[1]).toMatchObject({ organiserId: null, method: "BANK_TRANSFER" });
    expect(r.proposals[1]!.issues.map((i) => i.level)).toContain("error");
    // Nothing was posted by the agent.
    expect(await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.organisationId, x.org.id))).toHaveLength(0);
    // Once recorded, the same reference is flagged as a duplicate; paying more than owed is flagged as overpayment.
    await recordOrganiserPayment(x.actor, { mode: "test", organiserId: org!.id, eventId: x.event.id, amount: 2000, currency: "eur", paymentDate: "2026-09-15", bankReference: "Wise #123", method: "BANK_TRANSFER", notes: null, status: "PAID" });
    setAiCompleter(async () => ({ content: answer(50, "WISE 123") }));
    const r2 = await analysePaymentText(x.actor, "test", { text: "again" });
    expect(r2.proposals[0]!.duplicates).toHaveLength(1);
    expect(r2.proposals[0]!.balance).toMatchObject({ remaining: 1500, after: -3500 });
    expect(r2.proposals[0]!.issues.some((i) => /Overpayment/.test(i.text))).toBe(true);
    setAiCompleter(null); setAiChecker(null);
  });
});

describe("Wise bank feed", () => {
  it("connects read-only, imports transfers + statement lines, links recorded payments, suggests organisers, matches Stripe payouts", async () => {
    const x = await setup();
    const w = await import("@/server/accounting/wise");
    const { recordOrganiserPayment } = await import("@/server/accounting/manual");
    const [org] = await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, x.org.id));
    await db.insert(schema.stripePayouts).values({ organisationId: x.org.id, stripeAccountRef: x.acc.id, livemode: true, payoutId: "po_wise1", amount: 400000, currency: "gbp", status: "paid", stripeCreatedAt: new Date("2026-10-06T19:55:00Z"), arrivalDate: new Date("2026-10-07T00:00:00Z") });
    let signedWith: string | null = null;
    w.setWiseApi({
      profiles: async (token) => { if (token !== "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") throw new Error("bad token"); return [{ id: "1", type: "PERSONAL", name: "Me" }, { id: "2", type: "BUSINESS", name: "Bilit Platform" }]; },
      balances: async () => [{ id: "b1", currency: "gbp", amount: 123456 }],
      transfers: async (_t, pid, p) => (pid === "2" && p.offset === 0 ? [
        { id: 111, status: "outgoing_payment_sent", created: "2026-10-07 09:00:00", sourceValue: 4010, sourceCurrency: "GBP", targetValue: 4000, targetCurrency: "GBP", reference: "Bilit", targetAccount: 9 },
        { id: 222, status: "outgoing_payment_sent", created: "2026-10-07 10:00:00", sourceValue: 2200, sourceCurrency: "GBP", targetValue: 2500, targetCurrency: "EUR", reference: null, targetAccount: 10 },
        { id: 444, status: "outgoing_payment_sent", created: "2026-10-07 07:00:00", sourceValue: 1250.5, sourceCurrency: "GBP", targetValue: 1250.5, targetCurrency: "GBP", reference: "PAYOUT", targetAccount: 11 },
        { id: 333, status: "cancelled", created: "2026-10-07 11:00:00", sourceValue: 5, sourceCurrency: "GBP", targetValue: 5, targetCurrency: "GBP", targetAccount: 10 },
      ] : []),
      recipientName: async (_t, id) => (id === 9 ? "CONCERTS LIMITED" : id === 11 ? "Bilit Events Ltd" : "Someone Else"),
      activities: async () => ({ cursor: null, activities: [
        { id: "a1", type: "TRANSFER", resource: { type: "TRANSFER", id: "444" }, title: "<strong>Stripe Payments UK Ltd</strong>", primaryAmount: "<positive>+ 1,250.50 GBP</positive>", status: "COMPLETED", createdOn: "2026-10-07T07:00:00Z" },
        { id: "a2", type: "TRANSFER", resource: { type: "TRANSFER", id: "222" }, title: "<strong>Someone Else</strong>", primaryAmount: "2,500 EUR", secondaryAmount: "2,213.40 GBP", status: "COMPLETED", createdOn: "2026-10-07T10:00:00Z" },
        { id: "a3", type: "CARD_PAYMENT", resource: { type: "CARD_TRANSACTION", id: "c1" }, title: "<strong>Hetzner</strong>", description: "Spent by Sina", primaryAmount: "52.33 EUR", secondaryAmount: "", status: "COMPLETED", createdOn: "2026-10-05T10:00:00Z" },
      ] }),
      statement: async (_t, _p, _b, _r, key) => { signedWith = key; return [
        { type: "DEBIT", date: "2026-10-07T09:00:00Z", amount: { value: -4010, currency: "GBP" }, totalFees: { value: 10 }, referenceNumber: "TRANSFER-111", details: { type: "TRANSFER", description: "Sent money to Concerts" } },
        { type: "CREDIT", date: "2026-10-07T08:00:00Z", amount: { value: 4000, currency: "GBP" }, referenceNumber: "DEPOSIT-77", details: { type: "DEPOSIT", senderName: "Stripe Payments UK" } },
      ]; },
    });
    await expect(w.connectWise(x.actor, w.ConnectInput.parse({ token: "aaaaaaaa-bbbb-cccc-dddd-000000000000" }))).rejects.toThrow(/bad token/);
    const st = await w.connectWise(x.actor, w.ConnectInput.parse({ token: " aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n" }));
    expect(st).toMatchObject({ connected: true, profileId: "2", tokenHint: "aaaa…eeee" });
    expect(JSON.stringify(await w.getWiseStatus(x.org.id))).not.toContain("bbbb-cccc");
    // An organiser payment already recorded with the Wise number is linked, not flagged.
    const pay = await recordOrganiserPayment(x.actor, { mode: "live", organiserId: org!.id, eventId: null, amount: 400000, currency: "gbp", paymentDate: "2026-10-07", bankReference: "Wise - 111", method: "BANK_TRANSFER", notes: null, status: "PAID" });
    const r = await w.syncWise(x.org.id);
    expect(r).toMatchObject({ transfers: 4, activities: 1, statementLines: 2, statementsOk: true });
    expect(signedWith).toContain("PRIVATE KEY");
    const all = (await w.listWise(x.org.id, { view: "all" }, { limit: 50, offset: 0 })).items;
    const t111 = all.find((t) => t.wiseId === "TRANSFER-111")!;
    expect(t111).toMatchObject({ organiserPaymentId: pay.id, amount: 400000, fee: 1000, sourceAmount: 401000, counterparty: "CONCERTS LIMITED" });
    expect(all.find((t) => t.wiseId.startsWith("DEPOSIT-77"))).toMatchObject({ direction: "IN", stripePayoutId: "po_wise1" });
    // The activity feed shows the true direction: a "transfer to ourselves" is a Stripe payout coming in.
    expect(all.find((t) => t.wiseId === "TRANSFER-444")).toMatchObject({ direction: "IN", kind: "DEPOSIT", counterparty: "Stripe Payments UK Ltd", amount: 125050 });
    expect(all.find((t) => t.wiseId === "TRANSFER-222")).toMatchObject({ fee: 1340 }); // 2,213.40 debited − 2,200 converted
    expect(all.find((t) => t.wiseId.startsWith("ACT-CARD"))).toMatchObject({ direction: "OUT", kind: "CARD", amount: 5233, counterparty: "Hetzner" });
    const todo = (await w.listWise(x.org.id, { view: "torecord" }, { limit: 50, offset: 0 })).items;
    expect(todo.map((t) => t.wiseId)).toEqual(["TRANSFER-222"]); // cancelled transfer and recorded one are not flagged
    await expectPg(w.setWiseIgnored(x.actor, todo[0]!.id, { ignored: true }), /Say what this transfer was/);
    await w.setWiseIgnored(x.actor, todo[0]!.id, { ignored: true, reason: "own account" });
    expect((await w.getWiseStatus(x.org.id)) as { toRecord: number }).toMatchObject({ toRecord: 0 });
    // Suggestion by recipient name when nothing is recorded yet.
    await db.update(schema.acctWiseTransactions).set({ organiserPaymentId: null }).where(eq(schema.acctWiseTransactions.id, t111.id));
    const { voidOrganiserPayment } = await import("@/server/accounting/manual");
    await voidOrganiserPayment(x.actor, pay.id, "test void");
    await w.relinkWise(x.org.id);
    const again = (await w.listWise(x.org.id, { view: "torecord" }, { limit: 50, offset: 0 })).items;
    expect(again[0]).toMatchObject({ wiseId: "TRANSFER-111", suggestedOrganiserId: org!.id });
    await w.disconnectWise(x.actor);
    expect(await w.getWiseStatus(x.org.id)).toEqual({ connected: false });
    w.setWiseApi(null);
  });
});

describe("finance chat agent", () => {
  it("looks things up with tools, proposes a payment without executing it, and executes only on confirm", async () => {
    const x = await setup();
    const ag = await import("@/server/accounting/agent");
    const { setAiChecker, updateAiSettings } = await import("@/server/accounting/ai");
    setAiChecker(async () => {});
    await updateAiSettings(x.actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-test1234567890abcdefghijk", instructions: null });
    const [org] = await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, x.org.id));
    let turn = 0; const seen: string[] = [];
    ag.setAgentLlm(async ({ messages }) => {
      turn++;
      const last = messages[messages.length - 1]!;
      if (last.role === "tool") seen.push(String(last.content));
      if (turn === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_organisers", arguments: JSON.stringify({ query: "concerts" }) } }] } };
      if (turn === 2) return { message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "propose_record_payment", arguments: JSON.stringify({ organiserId: org!.id, amount: 20, currency: "EUR", paymentDate: "2026-10-07", method: "BANK_TRANSFER", bankReference: "Wise #9", status: "PAID" }) } }] } };
      return { message: { role: "assistant", content: "I prepared the payment — please confirm." } };
    });
    const r = await ag.runAgentChat(x.actor, "test", { messages: [{ role: "user", content: "Record €20 paid to Concerts today by Wise #9" }] });
    expect(seen[0]).toContain("Concerts Ltd"); expect(seen[0]).toContain("€35.00"); // balance shown to the model
    expect(seen.join(" ")).not.toContain("ali@example.test");
    expect(r.steps).toEqual(["organisers"]);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.action).toMatchObject({ kind: "record_payment", amount: 2000, currency: "eur", mode: "test" });
    expect(await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.organisationId, x.org.id))).toHaveLength(0);
    await ag.executeAction(x.actor, r.proposals[0]!.action);
    expect(await db.select().from(schema.acctOrganiserPayments).where(eq(schema.acctOrganiserPayments.organisationId, x.org.id))).toHaveLength(1);
    ag.setAgentLlm(null); setAiChecker(null);
  });
});

describe("Wise → expense / supplier invoice", () => {
  it("links a Wise transfer to the expense booked with its Wise number, and the agent can propose + book an expense", async () => {
    const x = await setup();
    const w = await import("@/server/accounting/wise");
    const ag = await import("@/server/accounting/agent");
    const { createBill } = await import("@/server/accounting/books");
    const { ensureLedgerSetup } = await import("@/server/accounting/core");
    await db.transaction((tx) => ensureLedgerSetup(tx, x.org.id));
    const [acc] = await db.select().from(schema.acctAccounts).where(and(eq(schema.acctAccounts.organisationId, x.org.id), eq(schema.acctAccounts.type, "EXPENSE"), eq(schema.acctAccounts.code, "6900")));
    const [t] = await db.insert(schema.acctWiseTransactions).values({ organisationId: x.org.id, wiseId: "TRANSFER-555", source: "TRANSFER", direction: "OUT", kind: "TRANSFER", status: "outgoing_payment_sent", occurredAt: new Date("2026-09-22T10:00:00Z"), amount: 40000, currency: "gbp", counterparty: "UNI TRAVEL LONDON LTD", reference: "Inv-035" }).returning();
    expect((await w.listWise(x.org.id, { view: "torecord" }, { limit: 50, offset: 0 })).items.map((i) => i.id)).toContain(t!.id);
    await createBill(x.actor, { mode: "live", kind: "BILL", supplierName: "Uni Travel London Ltd", supplierVat: null, country: "GB", invoiceNumber: "Inv-035", invoiceDate: "2026-09-22", dueDate: null, currency: "gbp", netAmount: 40000, vatAmount: 0, accountId: acc!.id, eventId: null, description: null, paidFrom: "BANK", paidDate: "2026-09-22", paymentReference: "Wise #555" });
    const after = await w.listWise(x.org.id, { view: "all" }, { limit: 50, offset: 0 });
    expect(after.items.find((i) => i.id === t!.id)).toMatchObject({ billKind: "BILL", billSupplier: "Uni Travel London Ltd" });
    expect((await w.listWise(x.org.id, { view: "torecord" }, { limit: 50, offset: 0 })).items.map((i) => i.id)).not.toContain(t!.id);
    // Agent proposal → confirm books an expense.
    const { setAiChecker, updateAiSettings } = await import("@/server/accounting/ai");
    setAiChecker(async () => {});
    await updateAiSettings(x.actor, { enabled: true, model: "gpt-4.1", apiKey: "sk-test1234567890abcdefghijk", instructions: null });
    let n = 0;
    ag.setAgentLlm(async () => (++n === 1 ? { message: { role: "assistant", content: null, tool_calls: [{ id: "e1", type: "function", function: { name: "propose_record_expense", arguments: JSON.stringify({ docKind: "EXPENSE", supplierName: "Hetzner", date: "2026-10-04", currency: "eur", total: 144.89, vat: null, accountId: acc!.id, paidFrom: "CARD", bankReference: "Wise #4432" }) } }] } } : { message: { role: "assistant", content: "Please confirm." } }));
    const r = await ag.runAgentChat(x.actor, "live", { messages: [{ role: "user", content: "Book the Hetzner card payment as an expense" }] });
    expect(r.proposals[0]!.action).toMatchObject({ kind: "record_expense", netAmount: 14489, vatAmount: 0, mode: "live" });
    const done = await ag.executeAction(x.actor, r.proposals[0]!.action);
    expect(done.done).toBe("Expense booked");
    ag.setAgentLlm(null); setAiChecker(null);
  });
});

describe("Wise bulk booking", () => {
  it("books several Wise transfers as expenses / organiser payments / ignored, each linked, failures reported per item", async () => {
    const x = await setup();
    const w = await import("@/server/accounting/wise");
    const { ensureLedgerSetup } = await import("@/server/accounting/core");
    await db.transaction((tx) => ensureLedgerSetup(tx, x.org.id));
    const [acc] = await db.select().from(schema.acctAccounts).where(and(eq(schema.acctAccounts.organisationId, x.org.id), eq(schema.acctAccounts.code, "6900")));
    const [org] = await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.organisationId, x.org.id));
    const mk = (id: string, amount: number, kind = "TRANSFER", currency = "gbp") => ({ organisationId: x.org.id, wiseId: id, source: "TRANSFER", direction: "OUT", kind, status: "completed", occurredAt: new Date("2026-09-20T10:00:00Z"), amount, currency, counterparty: `Payee ${id}` });
    const rows = await db.insert(schema.acctWiseTransactions).values([mk("TRANSFER-1001", 5000), mk("ACT-CARD_TRANSACTION-77", 1234, "CARD"), mk("TRANSFER-1002", 2000, "TRANSFER", "eur"), mk("TRANSFER-1003", 700)]).returning();
    await expectPg(w.bulkWise(x.actor, { ids: [rows[0]!.id], action: "expense" }), /Choose an expense category/);
    const r = await w.bulkWise(x.actor, { ids: [rows[0]!.id, rows[1]!.id], action: "expense", accountId: acc!.id });
    expect(r).toMatchObject({ done: 2, failed: [] });
    const r2 = await w.bulkWise(x.actor, { ids: [rows[2]!.id, rows[0]!.id], action: "organiser", organiserId: org!.id });
    expect(r2.done).toBe(1); expect(r2.failed[0]!.error).toMatch(/Already in the books/);
    await w.bulkWise(x.actor, { ids: [rows[3]!.id], action: "ignore", reason: "own account" });
    const all = (await w.listWise(x.org.id, { view: "all" }, { limit: 50, offset: 0 })).items;
    const by = (id: string) => all.find((i) => i.wiseId === id)!;
    expect(by("TRANSFER-1001")).toMatchObject({ billKind: "EXPENSE", billSupplier: "Payee TRANSFER-1001" });
    expect(by("ACT-CARD_TRANSACTION-77")).toMatchObject({ billKind: "EXPENSE" });
    expect(by("TRANSFER-1002").organiserPaymentId).toBeTruthy();
    expect(by("TRANSFER-1003")).toMatchObject({ ignored: true, ignoredReason: "own account" });
    const bills = await db.select().from(schema.acctBills).where(eq(schema.acctBills.organisationId, x.org.id));
    expect(bills.find((b) => b.paymentReference === "Wise #77")).toMatchObject({ paidFrom: "CARD", totalAmount: 1234 });
  });
});

describe("profit share (developer % of event profit)", () => {
  it("accrues % of each event's profit before shares, trues up on changes, payments reduce what is owed", async () => {
    const x = await setup();
    const ps = await import("@/server/accounting/profit-share");
    const before = (await eventFinancials(x.org.id, "test", { eventIds: [x.event.id] }))[0]!;
    const profit = before.bilitProfit;
    expect(profit).toBeGreaterThan(0);
    const p = await ps.savePartner(x.actor, null, ps.PartnerInput.parse({ name: "Morteza", role: "Web developer", sharePercent: 10 }));
    const o1 = await ps.partnerOverview(x.org.id, "test", p.id);
    const share = Math.round(profit * 0.1);
    expect(o1.totals[0]).toMatchObject({ currency: "eur", earned: share, paid: 0, owed: share, profit });
    expect((await ps.syncProfitShares(x.org.id, "test")).posted).toBe(0); // idempotent
    // The share is a Bilit cost but never reduces its own base.
    const after = (await eventFinancials(x.org.id, "test", { eventIds: [x.event.id] }))[0]!;
    expect(after.bilitProfit).toBe(profit - share);
    expect(after.profitShare).toBe(share);
    // Changing the % books only the difference.
    await ps.savePartner(x.actor, p.id, ps.PartnerInput.parse({ name: "Morteza", sharePercent: 20 }));
    const o2 = await ps.partnerOverview(x.org.id, "test", p.id);
    expect(o2.totals[0]!.earned).toBe(Math.round(profit * 0.2));
    const pay = await ps.recordPartnerPayment(x.actor, ps.PartnerPaymentInput.parse({ mode: "test", partnerId: p.id, amount: 10, currency: "eur", paymentDate: "2026-10-07", bankReference: "Wise #42" }));
    expect((await ps.partnerOverview(x.org.id, "test", p.id)).totals[0]).toMatchObject({ paid: 10, owed: Math.round(profit * 0.2) - 10 });
    await ps.voidPartnerPayment(x.actor, pay.id, "test");
    expect((await ps.partnerOverview(x.org.id, "test", p.id)).totals[0]).toMatchObject({ paid: 0 });
    const tb = await trialBalance(x.org.id, "test");
    const sum = tb.filter((r) => r.currency === "eur").reduce((s, r) => s + r.debit - r.credit, 0);
    expect(sum).toBe(0);
    const pdf = await ps.partnerStatementPdf(x.org.id, "test", p.id);
    expect(pdf.bytes.subarray(0, 4).toString()).toBe("%PDF");
  });
});
