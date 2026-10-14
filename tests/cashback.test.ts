import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { encrypt } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { ensureLedgerSetup } from "@/server/accounting/core";
import { setStripeGatewayFactory, type StripeAccountRow } from "@/server/accounting/stripe-gateway";
import { importBalanceTransaction, importContext } from "@/server/accounting/importer";
import { createEvent, createOrganiser, updateEvent, updateOrganiser } from "@/server/accounting/entities";
import { cashbackTarget, syncCashback } from "@/server/accounting/cashback";
import { eventFinancials, organiserFinancials } from "@/server/accounting/finance";
import { organiserReportData } from "@/server/accounting/organiser-report";
import { ctxFor, makeOrg } from "./helpers";
import { FakeStripe } from "./stripe-fixtures";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { setStripeGatewayFactory(null); await stopBoss(); });

describe("cashback target (pure)", () => {
  const ev = (organiserShare: number, eventStatus = "COMPLETED", startsOn: string | null = "2026-10-11") => ({ organiserShare, eventStatus, startsOn });
  it("is the % of ticket sales after refunds, only on finished events, never negative", () => {
    expect(cashbackTarget(ev(1732754), { cashbackBps: 100, cashbackFrom: null })).toBe(17328); // Frankfurt: €17,327.54 → €173.28
    expect(cashbackTarget(ev(1732754, "ACTIVE"), { cashbackBps: 100, cashbackFrom: null })).toBe(0);
    expect(cashbackTarget(ev(-12485, "COMPLETED"), { cashbackBps: 100, cashbackFrom: null })).toBe(0);
    expect(cashbackTarget(ev(1732754), { cashbackBps: 0, cashbackFrom: null })).toBe(0);
  });
  it("respects the 'applies from' date (events without a date are included)", () => {
    expect(cashbackTarget(ev(10000, "COMPLETED", "2026-09-30"), { cashbackBps: 100, cashbackFrom: "2026-10-01" })).toBe(0);
    expect(cashbackTarget(ev(10000, "COMPLETED", "2026-10-01"), { cashbackBps: 100, cashbackFrom: "2026-10-01" })).toBe(100);
    expect(cashbackTarget(ev(10000, "COMPLETED", null), { cashbackBps: 100, cashbackFrom: "2026-10-01" })).toBe(100);
  });
});

describe("cashback in the books", () => {
  let orgId = "", organiserId = "", eventId = "";
  let actor: { orgId: string; userId: string; ctx: ReturnType<typeof ctxFor> };
  let fake: FakeStripe; let acc: StripeAccountRow;
  const fig = async () => (await eventFinancials(orgId, "test", { eventIds: [eventId] }))[0]!;

  beforeAll(async () => {
    const { org, user } = await makeOrg("Cashback Test");
    orgId = org.id; actor = { orgId, userId: user.id, ctx: ctxFor() };
    fake = new FakeStripe(); setStripeGatewayFactory(() => fake);
    acc = (await db.insert(schema.stripeAccounts).values({ organisationId: orgId, livemode: false, secretKeyEnc: encrypt(`sk_test_${randomBytes(12).toString("hex")}`), keyHint: "sk_test_…x", status: "CONNECTED", stripeAccountId: "acct_1CASHBACK" }).returning())[0] as StripeAccountRow;
    await ensureLedgerSetup(db, orgId);
    const o = await createOrganiser(actor, { name: "Wave Events", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null, cashbackPercent: 1 });
    organiserId = o.id;
    const ev = await createEvent(actor, { name: "Show", code: `CB-${randomBytes(2).toString("hex")}`, currency: "eur", organiserId, startsOn: "2026-10-11", status: "ACTIVE", notes: null, agreement: { percentBps: 1000, percentBasis: "GROSS", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "ORGANISER", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: true, notes: null } });
    eventId = ev.id;
    const { bt } = fake.sale({ amount: 11000, fee: 300, description: `Show ${ev.code}` });
    await importBalanceTransaction(await importContext(acc, fake), bt);
  });

  it("nothing while the event is live; once finished the cashback is added to what the organiser is owed", async () => {
    await syncCashback(orgId, "test");
    const before = await fig();
    expect(before.cashback).toBe(0);
    await updateEvent(actor, eventId, { status: "COMPLETED", reason: null });
    await syncCashback(orgId, "test");
    const after = await fig();
    expect(after.cashback).toBe(Math.round(before.organiserShare / 100));
    expect(after.organiserDue).toBe(before.organiserDue + after.cashback);
    expect(after.deductions).toBe(before.deductions);
    expect(after.bilitProfit).toBe(before.bilitProfit - after.cashback);
    // organiser-level balances see it too (lines carry the organiser)
    const acct = await organiserFinancials(orgId, "test", organiserId);
    expect(acct.totals[0]!.organiserDue).toBe(after.organiserDue);
  });

  it("is idempotent, follows a rate change, and is withdrawn if the event is re-opened", async () => {
    const n = async () => (await db.execute<{ n: number }>(sql`select count(*)::int n from acct_journal_entries where organisation_id = ${orgId} and source_type = 'organiser_cashback'`)).rows[0]!.n;
    const k = await n();
    await syncCashback(orgId, "test");
    expect(await n()).toBe(k);
    await updateOrganiser(actor, organiserId, { cashbackPercent: 2 });
    await syncCashback(orgId, "test");
    const f2 = await fig();
    expect(f2.cashback).toBe(Math.round((f2.organiserShare * 200) / 10_000));
    await updateEvent(actor, eventId, { status: "ACTIVE", reason: null });
    await syncCashback(orgId, "test");
    expect((await fig()).cashback).toBe(0);
    const [bal] = (await db.execute<{ d: string; c: string }>(sql`select sum(debit)::text d, sum(credit)::text c from acct_journal_lines where organisation_id = ${orgId}`)).rows;
    expect(bal!.d).toBe(bal!.c);
  });

  it("the settlement statement includes the cashback in the balance due", async () => {
    await updateEvent(actor, eventId, { status: "COMPLETED", reason: null });
    const d = await organiserReportData(orgId, "test", organiserId, { eventIds: [eventId] });
    const f = await fig();
    expect(f.cashback).toBeGreaterThan(0);
    expect(d.statement![0]!.due).toBe(f.organiserDue);
    const [o] = await db.select().from(schema.acctOrganisers).where(eq(schema.acctOrganisers.id, organiserId));
    expect(o!.cashbackBps).toBe(200);
  });

  it("repairs cashback booked without the organiser on its lines: reversed and re-booked once, totals then agree", async () => {
    await syncCashback(orgId, "test");
    const f = await fig();
    // simulate an entry from before the fix: reverse the current ones, post an old-style entry with no organiser on lines
    const cur = await db.execute<{ id: string }>(sql`select id from acct_journal_entries where organisation_id = ${orgId} and source_type = 'organiser_cashback' and status <> 'REVERSED' and entry_type <> 'REVERSAL'`);
    const { postEntry, reverseEntry } = await import("@/server/accounting/ledger");
    for (const r of cur.rows) await db.transaction((tx) => reverseEntry(tx, { orgId, entryId: r.id, reason: "test", timezone: "UTC" }));
    await db.transaction((tx) => postEntry(tx, { orgId, livemode: false, entryType: "ADJUSTMENT", sourceDate: new Date(), entryDate: "2026-10-14", currency: "eur", description: "old style", eventId, organiserId, sourceType: "organiser_cashback", sourceId: organiserId, idempotencyKey: `old:${randomBytes(4).toString("hex")}`, timezone: "UTC",
      postings: [{ account: "organiser_cashback", amount: f.cashback, eventId }, { account: "organiser_payable", amount: -f.cashback, eventId }] }));
    expect((await organiserFinancials(orgId, "test", organiserId)).totals[0]!.organiserDue).toBe(f.organiserDue - f.cashback); // the bug
    await syncCashback(orgId, "test");
    expect((await fig()).cashback).toBe(f.cashback);
    expect((await organiserFinancials(orgId, "test", organiserId)).totals[0]!.organiserDue).toBe(f.organiserDue);
    await syncCashback(orgId, "test"); // nothing left to repair
    expect((await fig()).cashback).toBe(f.cashback);
  });
});

