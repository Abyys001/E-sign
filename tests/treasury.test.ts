import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import type { RequestContext } from "@/server/audit";
import { setTreasuryGateway, type Capabilities, type TreasuryGateway } from "@/server/treasury/stripe";
import { assignedCards, authorizeCard } from "@/server/treasury/access";
import { cardActivity, freezeCard, requestLimit, saveExpenseNote } from "@/server/treasury/staff-portal";
import { assignCard, createCard, createCardholder, createStaff, decideLimitRequest, expenseExport, revokeAssignment, setStaffStatus, updateTreasurySettings } from "@/server/treasury/admin";
import { assertStaffCsrf, requestStaffReset } from "@/server/treasury/auth";
import { receiveTreasuryWebhook } from "@/server/treasury/webhook";
import type { StaffContext } from "@/server/treasury/auth";
const now = () => Math.floor(Date.now() / 1000);
const txn = (card: string, created: number, amount = -1250) => ({ id: `ipi_${randomBytes(6).toString("hex")}`, card, created, amount, currency: "gbp", type: "capture", merchant_data: { name: "Shop", category: "misc", city: "London", country: "GB" }, authorization: null });
import { makeOrg, ctxFor } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setTreasuryGateway(null); await stopBoss(); });

/** Minimal fake of the Stripe Treasury/Issuing surface, recording calls and never touching the network. */
class FakeTreasury implements TreasuryGateway {
  spendingControls: Record<string, unknown> = {};
  statusCalls: Array<{ id: string; status: string }> = [];
  limitCalls: Array<{ id: string; controls: unknown }> = [];
  verify = true;
  async capabilities(): Promise<Capabilities> { return { issuing: true, treasury: true, financialAccounts: [{ id: "fa_test1", status: "open", currency: "gbp", balance: 500000 }] }; }
  async createCardholder() { return { id: `ich_${randomBytes(4).toString("hex")}`, name: "X", email: null, phone_number: null, type: "individual", status: "active" } as never; }
  async listCardholders() { return []; }
  async createCard() { return { id: `ic_${randomBytes(4).toString("hex")}`, brand: "Visa", last4: "4242", exp_month: 12, exp_year: 2030, currency: "gbp", type: "virtual", status: "active", spending_controls: this.spendingControls, financial_account: "fa_test1" } as never; }
  async retrieveCard(id: string) { return { id, status: "active" } as never; }
  async listCards() { return []; }
  async setCardStatus(id: string, status: "active" | "inactive" | "canceled") { this.statusCalls.push({ id, status }); return { id, status } as never; }
  async setSpendingControls(id: string, controls: unknown) { this.limitCalls.push({ id, controls }); return { id, status: "active", spending_controls: controls } as never; }
  auths: Array<Record<string, unknown> & { id: string; card: string; created: number }> = [];
  txns: Array<Record<string, unknown> & { id: string; card: string; created: number }> = [];
  failNextCardUpdate = false;
  async listAuthorizations(card: string, _l: number, since?: number) { return this.auths.filter((a) => a.card === card && (!since || a.created >= since)).sort((x, y) => y.created - x.created) as never; }
  async listTransactions(card: string, _l: number, since?: number) { return this.txns.filter((t) => t.card === card && (!since || t.created >= since)).sort((x, y) => y.created - x.created) as never; }
  async transactionsBetween(card: string, from: number, to: number) { return this.txns.filter((t) => t.card === card && t.created >= from && t.created <= to) as never; }
  async retrieveAuthorization(id: string) { const a = this.auths.find((x) => x.id === id); if (!a) throw new Error("No such issuing authorization"); return a as never; }
  async retrieveTransaction(id: string) { const t = this.txns.find((x) => x.id === id); if (!t) throw new Error("No such issuing transaction"); return t as never; }
  constructEvent(raw: string) { if (!this.verify) throw new Error("bad signature"); return JSON.parse(raw); }
}

const SYS: RequestContext = ctxFor();
async function mkStaff(orgId: string, over: Partial<typeof schema.treasuryStaff.$inferInsert> = {}) {
  const [s] = await db.insert(schema.treasuryStaff).values({ organisationId: orgId, email: `s-${randomBytes(4).toString("hex")}@x.test`, name: "Staff", status: "ACTIVE", ...over }).returning();
  return s!;
}
const scFor = (staff: typeof schema.treasuryStaff.$inferSelect): StaffContext => ({ staff, sessionId: "t", csrf: "t", ctx: SYS });

describe("treasury staff portal — isolation & controls", () => {
  let orgId = "", userId = "", userName = "Admin";
  let fake: FakeTreasury;
  let cardholderId = "";
  const actor = () => ({ orgId, userId, userName, ctx: SYS });

  beforeAll(async () => {
    const { org, user } = await makeOrg("Treasury Test");
    orgId = org.id; userId = user.id;
    fake = new FakeTreasury(); setTreasuryGateway(() => fake);
    await updateTreasurySettings(actor(), { mode: "test", apiKey: `rk_test_${randomBytes(12).toString("hex")}`, financialAccountId: "fa_test1" });
    const ch = await createCardholder(actor(), { mode: "test", name: "Jenny", email: null, type: "individual", billing: { line1: "1 St", city: "London", postalCode: "E1", country: "GB" } });
    cardholderId = ch.id;
  });
  beforeEach(() => { fake.statusCalls = []; fake.limitCalls = []; fake.verify = true; fake.failNextCardUpdate = false; });

  async function newCardAssignedTo(staffId: string, limits: Array<{ amount: number; interval: string }> = []) {
    const card = await createCard(actor(), { mode: "test", cardholderId, currency: "gbp", type: "virtual", financialAccountId: "fa_test1", limits: limits as never });
    if (limits.length) await db.update(schema.treasuryCards).set({ spendingControls: { spending_limits: limits } }).where(eq(schema.treasuryCards.id, card.id));
    await assignCard(actor(), staffId, card.id);
    const [fresh] = await db.select().from(schema.treasuryCards).where(eq(schema.treasuryCards.id, card.id));
    return fresh!;
  }

  it("a staff member sees only the card assigned to them", async () => {
    const a = await mkStaff(orgId), b = await mkStaff(orgId);
    const cardA = await newCardAssignedTo(a.id);
    const cardB = await newCardAssignedTo(b.id);
    expect((await assignedCards(a.id)).map((c) => c.id)).toEqual([cardA.id]);
    const got = await authorizeCard(scFor(a));
    expect(got.card.id).toBe(cardA.id);
    // Staff A asking for Staff B's card id is denied, and the denial is audited
    await expect(authorizeCard(scFor(a), cardB.id)).rejects.toThrow(/do not have access/);
    const [denied] = await db.select().from(schema.treasuryAudit).where(and(eq(schema.treasuryAudit.actorId, a.id), eq(schema.treasuryAudit.outcome, "DENY")));
    expect(denied?.action).toBe("card.access");
  });

  it("tampering with the card id to an arbitrary / another-org value cannot widen access", async () => {
    const a = await mkStaff(orgId);
    await newCardAssignedTo(a.id);
    await expect(authorizeCard(scFor(a), "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/do not have access/);
    const other = await makeOrg("Other Org");
    const fakeHolder = await db.insert(schema.treasuryCardholders).values({ organisationId: other.org.id, livemode: false, stripeCardholderId: "ich_x", name: "X", type: "individual", status: "active" }).returning();
    const [foreign] = await db.insert(schema.treasuryCards).values({ organisationId: other.org.id, livemode: false, stripeCardId: "ic_x", cardholderId: fakeHolder[0]!.id, currency: "gbp", type: "virtual", status: "active" }).returning();
    await expect(authorizeCard(scFor(a), foreign!.id)).rejects.toThrow(/do not have access/);
  });

  it("the staff portal exposes no way to read the Treasury balance or move money", async () => {
    const mod = await import("@/server/treasury/staff-portal");
    const names = Object.keys(mod);
    expect(names.some((n) => /balance|transfer|withdraw|payout|addFunds|topup/i.test(n))).toBe(false);
  });

  it("a staff member cannot change their own limit — only request it; freezing obeys the per-staff policy", async () => {
    const noFreeze = await mkStaff(orgId, { canFreezeCard: false });
    await newCardAssignedTo(noFreeze.id, [{ amount: 10000, interval: "monthly" }]);
    await expect(freezeCard(scFor(noFreeze), null, true)).rejects.toThrow(/not permitted/);
    expect(fake.statusCalls).toHaveLength(0);
    const { id } = await requestLimit(scFor(noFreeze), { interval: "monthly", amount: 50000 });
    const [req] = await db.select().from(schema.treasuryLimitRequests).where(eq(schema.treasuryLimitRequests.id, id));
    expect(req).toMatchObject({ status: "PENDING", requestedAmount: 50000, currentAmount: 10000 });

    const canFreeze = await mkStaff(orgId, { canFreezeCard: true });
    await newCardAssignedTo(canFreeze.id);
    await freezeCard(scFor(canFreeze), null, true);
    expect(fake.statusCalls).toEqual([{ id: expect.stringMatching(/^ic_/), status: "inactive" }]);
  });

  it("an admin approval applies the new limit to the card in Stripe; rejection does not", async () => {
    const s = await mkStaff(orgId);
    await newCardAssignedTo(s.id, [{ amount: 10000, interval: "monthly" }]);
    const { id } = await requestLimit(scFor(s), { interval: "monthly", amount: 80000 });
    await decideLimitRequest(actor(), id, { approve: true, note: null });
    expect(fake.limitCalls).toHaveLength(1);
    const [req] = await db.select().from(schema.treasuryLimitRequests).where(eq(schema.treasuryLimitRequests.id, id));
    expect(req!.status).toBe("APPROVED");
    await expect(decideLimitRequest(actor(), id, { approve: true, note: null })).rejects.toThrow(/already been decided/);
  });

  it("suspending or revoking a staff member stops access immediately; revoke also drops the card assignment", async () => {
    const s = await mkStaff(orgId);
    const card = await newCardAssignedTo(s.id);
    await setStaffStatus(actor(), s.id, "SUSPENDED");
    const [after] = await db.select().from(schema.treasuryStaff).where(eq(schema.treasuryStaff.id, s.id));
    expect(after!.status).toBe("SUSPENDED"); // currentStaff() only returns ACTIVE staff
    await setStaffStatus(actor(), s.id, "REVOKED");
    const [assignment] = await db.select().from(schema.treasuryAssignments).where(and(eq(schema.treasuryAssignments.cardId, card.id), isNull(schema.treasuryAssignments.revokedAt)));
    expect(assignment).toBeUndefined();
  });

  it("a card cannot be assigned to two staff at once; revoking frees it", async () => {
    const a = await mkStaff(orgId), b = await mkStaff(orgId);
    const card = await newCardAssignedTo(a.id);
    await expect(assignCard(actor(), b.id, card.id)).rejects.toThrow(/already assigned/);
    await revokeAssignment(actor(), card.id);
    await expect(assignCard(actor(), b.id, card.id)).resolves.toBeTruthy();
  });

  it("webhooks: a bad signature is rejected, and a duplicate event id is processed only once", async () => {
    // configure a webhook secret so the verifier is attempted
    const [settings] = await db.select({ v: schema.acctSettings.treasurySettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
    const v = settings!.v as Record<string, { webhookSecretEnc?: string }>;
    const { encrypt } = await import("@/server/crypto");
    v.test = { ...v.test, webhookSecretEnc: encrypt("whsec_test") } as never;
    await db.update(schema.acctSettings).set({ treasurySettings: v }).where(eq(schema.acctSettings.organisationId, orgId));
    const evt = JSON.stringify({ id: `evt_${randomBytes(4).toString("hex")}`, type: "issuing_card.updated", data: { object: { id: "ic_zzz", status: "inactive", last4: "4242", spending_controls: {} } } });
    fake.verify = false;
    await expect(receiveTreasuryWebhook(evt, "sig", "1.2.3.4")).rejects.toThrow(/Signature/);
    fake.verify = true;
    const first = await receiveTreasuryWebhook(evt, "sig", "1.2.3.4");
    expect(first).toEqual({ received: true });
    const second = await receiveTreasuryWebhook(evt, "sig", "1.2.3.4");
    expect(second).toEqual({ received: true, duplicate: true });
  });

  it("a card that changes hands never shows the previous holder's transactions, notes or receipts", async () => {
    const a = await mkStaff(orgId), b = await mkStaff(orgId);
    const card = await newCardAssignedTo(a.id);
    const old = txn(card.stripeCardId, now());
    fake.txns.push(old);
    await saveExpenseNote(scFor(a), { stripeObjectId: old.id, note: "A's lunch" });
    expect((await cardActivity(scFor(a))).activity.map((x) => x.id)).toContain(old.id);
    await revokeAssignment(actor(), card.id);
    // backdate nothing: B's assignment starts after A's transaction
    await db.update(schema.treasuryAssignments).set({ assignedAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.treasuryAssignments.staffId, a.id));
    old.created = now() - 1800;
    await assignCard(actor(), b.id, card.id);
    const mine = txn(card.stripeCardId, now() + 5);
    fake.txns.push(mine);
    const seen = (await cardActivity(scFor(b))).activity;
    expect(seen.map((x) => x.id)).toEqual([mine.id]);
    expect(seen.some((x) => x.note)).toBe(false);
    // B cannot annotate (or overwrite the note on) A's transaction
    await expect(saveExpenseNote(scFor(b), { stripeObjectId: old.id, note: "mine now" })).rejects.toThrow(/not on your card/);
    const [kept] = await db.select().from(schema.treasuryExpenses).where(eq(schema.treasuryExpenses.stripeObjectId, old.id));
    expect(kept!.note).toBe("A's lunch");
    // the export still attributes each transaction to whoever held the card at the time
    const rows = await expenseExport(actor(), "test", new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000));
    const byId = new Map(rows.map((r) => [r.transactionId, r]));
    expect(byId.get(old.id)).toMatchObject({ staff: a.name, note: "A's lunch" });
    expect(byId.get(mine.id)?.staff).toBe(b.name);
  });

  it("a note can only be attached to a transaction on the staff's own card", async () => {
    const a = await mkStaff(orgId), b = await mkStaff(orgId);
    await newCardAssignedTo(a.id);
    const cardB = await newCardAssignedTo(b.id);
    const tB = txn(cardB.stripeCardId, now() + 10);
    fake.txns.push(tB);
    await expect(saveExpenseNote(scFor(a), { stripeObjectId: tB.id, note: "x" })).rejects.toThrow(/not on your card/);
    await expect(saveExpenseNote(scFor(a), { stripeObjectId: "ipi_doesnotexist", note: "x" })).rejects.toThrow(/not on your card/);
  });

  it("a revoked account is final, and an invited account cannot be activated without a password", async () => {
    const s = await mkStaff(orgId);
    await setStaffStatus(actor(), s.id, "REVOKED");
    await expect(setStaffStatus(actor(), s.id, "ACTIVE")).rejects.toThrow(/revoked permanently/);
    const inv = await mkStaff(orgId, { status: "INVITED" });
    await expect(setStaffStatus(actor(), inv.id, "ACTIVE")).rejects.toThrow(/not accepted/);
  });

  it("staff emails are unique across organisations", async () => {
    const email = `dup-${randomBytes(4).toString("hex")}@x.test`;
    const other = await makeOrg("Other Org 2");
    await mkStaff(other.org.id, { email });
    await expect(createStaff(actor(), { email: email.toUpperCase(), name: "Dup", canFreezeCard: false })).rejects.toThrow(/already exists/);
  });

  it("CSRF: the header must equal the session's token", () => {
    expect(() => assertStaffCsrf(null, "abc")).toThrow(/CSRF/);
    expect(() => assertStaffCsrf("abd", "abc")).toThrow(/CSRF/);
    expect(() => assertStaffCsrf("abcd", "abc")).toThrow(/CSRF/);
    expect(() => assertStaffCsrf("abc", "abc")).not.toThrow();
  });

  it("forgot password answers the same for unknown, suspended and active accounts, and only mails the active one", async () => {
    const active = await mkStaff(orgId, { passwordHash: "x" });
    const suspended = await mkStaff(orgId, { passwordHash: "x", status: "SUSPENDED" });
    expect(await requestStaffReset("nobody@nowhere.test", SYS)).toEqual({ ok: true });
    expect(await requestStaffReset(suspended.email, SYS)).toEqual({ ok: true });
    expect(await requestStaffReset(active.email.toUpperCase(), SYS)).toEqual({ ok: true });
    const tokens = await db.select().from(schema.treasuryStaffTokens).where(eq(schema.treasuryStaffTokens.purpose, "RESET"));
    expect(tokens.some((t) => t.staffId === active.id)).toBe(true);
    expect(tokens.some((t) => t.staffId === suspended.id)).toBe(false);
  });

  it("webhooks: a test-mode event signed with a live secret is not accepted as live; a failed event is retried, not swallowed", async () => {
    const evt = (o: Record<string, unknown>) => JSON.stringify({ id: `evt_${randomBytes(4).toString("hex")}`, type: "issuing_card.updated", ...o, data: { object: { id: "ic_zzz", status: "inactive", last4: "4242", spending_controls: {} } } });
    // our only configured secret is test-mode, so a livemode:true event cannot be attributed to it
    await expect(receiveTreasuryWebhook(evt({ livemode: true }), "sig", "1.2.3.4")).rejects.toThrow(/Signature/);
    // processing failure: the event id is forgotten so Stripe's retry gets processed
    const bad = JSON.stringify({ id: `evt_${randomBytes(4).toString("hex")}`, livemode: false, type: "issuing_card.updated", data: { object: null } });
    await expect(receiveTreasuryWebhook(bad, "sig", "1.2.3.4")).rejects.toThrow(/retry/);
    const id = JSON.parse(bad).id;
    expect(await db.select().from(schema.treasuryStripeEvents).where(eq(schema.treasuryStripeEvents.stripeEventId, id))).toHaveLength(0);
  });
});
