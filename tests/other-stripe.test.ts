import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { eventFinancials } from "@/server/accounting/finance";
import { applyOtherStripe, parseStripePaymentsCsv, previewOtherStripe } from "@/server/accounting/other-stripe";
import { trialBalance } from "@/server/accounting/reports";
import { ctxFor, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { await stopBoss(); });

const HEAD = "id,Created date (UTC),Amount,Amount Refunded,Currency,Captured,Description,Fee,Status,Customer Email,Customer Description";

describe("old Stripe account Payments export", () => {
  it("reads the columns by name, amounts in minor units", () => {
    const [c] = parseStripePaymentsCsv(`${HEAD}\nch_1,2026-06-19 14:03:22,"1,792.00",0.00,sek,true,"Order (Ab1) for event: X (B17-0073), by A",65.40,Paid,a@b.c,Alex`);
    expect(c).toMatchObject({ id: "ch_1", amount: 179200, refunded: 0, fee: 6540, currency: "sek", status: "paid", customer: "Alex" });
    expect(c!.created.toISOString()).toBe("2026-06-19T14:03:22.000Z");
  });
  it("refuses a file that is not a Payments export", () => {
    expect(() => parseStripePaymentsCsv("Name,Email\nA,b")).toThrow(/Stripe Payments export/);
  });

  it("previews, books new sales on the event, skips duplicates, and is safe to run twice", async () => {
    const { org, user } = await makeOrg("Other Stripe Test");
    const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
    const { ensureLedgerSetup } = await import("@/server/accounting/core");
    await ensureLedgerSetup(db, org.id);
    const organiser = await createOrganiser(a, { name: "Pegasus", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
    const code = `GBG-${randomBytes(2).toString("hex").toUpperCase()}`;
    const event = await createEvent(a, { name: "Gothenburg", code, currency: "sek", organiserId: organiser.id, startsOn: "2026-10-23", status: "ACTIVE", notes: null, agreement: { percentBps: 1200, percentBasis: "ADDED", fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT", chargebacksBorneBy: "ORGANISER", refundsReverseCommission: false, notes: null } });
    const csv = [HEAD,
      `ch_new,2026-07-01 10:00:00,"3,584.00",0.00,sek,true,"Order (jE1) for event: Gothenburg (${code}), by A",100.00,Paid,,Anna`,
      `ch_ref,2026-07-02 10:00:00,1792.00,1792.00,sek,true,"Order (Bx2) for event: Gothenburg (${code}), by B",50.00,Refunded,,Bo`,
      `ch_fail,2026-07-03 10:00:00,1000.00,0.00,sek,false,"Order (Zz9) for event: Gothenburg (${code}), by C",0.00,Failed,,Cy`,
      `ch_other,2026-07-04 10:00:00,500.00,0.00,sek,true,"Order (Qq1) for event: Somewhere (NOPE-1), by D",10.00,Paid,,Di`,
    ].join("\n");
    const pre = await previewOtherStripe(org.id, "test", csv);
    expect(pre.counts).toMatchObject({ NEW: 2, NOT_PAID: 1, NO_EVENT: 1 });
    expect(pre.lines.find((l) => l.chargeId === "ch_new")).toMatchObject({ bookingFee: 38400, organiserShare: 320000, eventId: event.id, order: "jE1" });

    const r = await applyOtherStripe(a, "test", csv, "payments.csv");
    expect(r.booked).toBe(2);
    expect(r.failed).toEqual([]);
    const f = (await eventFinancials(org.id, "test", { eventIds: [event.id] }))[0]!;
    // Sale 3,584 (fee 384, organiser 3,200) + sale 1,792 (fee 192, organiser 1,600) refunded in full; the organiser bears the refund.
    expect(f).toMatchObject({ grossSales: 537600, refunds: 179200, bookingFees: 57600, organiserDue: 320000 - 19200, deductions: 0, processingFees: 15000 });
    expect((await trialBalance(org.id, "test")).reduce((s, x) => s + x.balance, 0)).toBe(0);

    const again = await applyOtherStripe(a, "test", csv, "payments.csv");
    expect(again.booked).toBe(0);
    expect(again.counts).toMatchObject({ NEW: 0, ALREADY_IMPORTED: 2 });
    const entries = await db.select().from(schema.acctJournalEntries).where(eq(schema.acctJournalEntries.organisationId, org.id));
    expect(entries.filter((e) => e.sourceType === "manual_sale")).toHaveLength(2);
    expect(entries.filter((e) => e.sourceType === "manual_refund")).toHaveLength(1);
  });
});
