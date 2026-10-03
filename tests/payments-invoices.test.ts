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
