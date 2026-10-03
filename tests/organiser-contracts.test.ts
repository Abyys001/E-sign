import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { stopBoss } from "@/server/jobs";
import { createEvent, createOrganiser } from "@/server/accounting/entities";
import { recordOrganiserPayment } from "@/server/accounting/manual";
import { eventContracts, linkContract, organiserContracts, unlinkContract } from "@/server/accounting/organiser-contracts";
import { organiserReportData, organiserReportPdf } from "@/server/accounting/organiser-report";
import { AGREEMENT_TYPES } from "@/server/agreements/types";
import { SEED_CLAUSES } from "@/server/clauses/library";
import { CATEGORIES } from "@/server/clauses/types";
import { ctxFor, makeOrg } from "./helpers";

process.env.ACCOUNTING_ENABLED = "true";
afterAll(async () => { await stopBoss(); });

let e: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const { org, user } = await makeOrg("Organiser Contracts Test");
  const actor = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const organiser = await createOrganiser(actor, { name: "Promo GmbH", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
  const other = await createOrganiser(actor, { name: "Other Ltd", email: null, companyName: null, vatNumber: null, address: null, internalRef: null, notes: null, active: true, bankDetails: null });
  const agreement = { percentBps: 1000, percentBasis: "ADDED" as const, fixedPerTicket: 0, fixedEventFee: 0, stripeFeesBorneBy: "BILIT" as const, chargebacksBorneBy: "ORGANISER" as const, refundsReverseCommission: true, notes: null };
  const event = await createEvent(actor, { name: "Gig", code: `GG-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "eur", organiserId: organiser.id, startsOn: null, status: "ACTIVE", notes: null, agreement });
  const otherEvent = await createEvent(actor, { name: "Other gig", code: `OG-${randomBytes(2).toString("hex").toUpperCase()}`, currency: "eur", organiserId: other.id, startsOn: null, status: "ACTIVE", notes: null, agreement });
  const mk = async (name: string, status: "DRAFT" | "COMPLETED") => (await db.insert(schema.contracts).values({ organisationId: org.id, reference: `CTR-2026-${randomBytes(3).toString("hex")}`, name, status, createdBy: user.id }).returning())[0]!;
  return { org, user, actor, organiser, event, otherEvent, master: await mk("Master", "COMPLETED"), schedule: await mk("Schedule", "DRAFT") };
}
beforeAll(async () => { e = await setup(); });

describe("promoter agreement library", () => {
  it("every promoter clause uses a known category and the two agreement types select them all", () => {
    const keys = SEED_CLAUSES.filter((c) => c.key.startsWith("pm.") || c.key.startsWith("ps."));
    expect(keys.length).toBeGreaterThan(60);
    for (const c of keys) expect(CATEGORIES).toContain(c.category);
    const master = AGREEMENT_TYPES.find((t) => t.key === "promoter_master")!;
    expect(master.clauses.map((c) => c.clauseKey)).toEqual(expect.arrayContaining(["pm.advance_recovery", "pm.governing_law", "pm.go_live"]));
    expect(AGREEMENT_TYPES.find((t) => t.key === "promoter_event_schedule")!.clauses.every((c) => c.clauseKey.startsWith("ps."))).toBe(true);
  });
});

describe("contracts linked to organisers and events", () => {
  it("links a master agreement and an event schedule; the event goes live only when both are signed", async () => {
    await linkContract(e.actor, e.organiser.id, { contractId: e.master.id, role: "MASTER" });
    await expect(linkContract(e.actor, e.organiser.id, { contractId: e.schedule.id, role: "EVENT_SCHEDULE" })).rejects.toThrow(/event/i);
    await expect(linkContract(e.actor, e.organiser.id, { contractId: e.schedule.id, role: "EVENT_SCHEDULE", eventId: e.otherEvent.id })).rejects.toThrow(/another organiser/);
    await linkContract(e.actor, e.organiser.id, { contractId: e.schedule.id, role: "EVENT_SCHEDULE", eventId: e.event.id });
    const list = await organiserContracts(e.org.id, e.organiser.id);
    expect(list.map((c) => [c.role, c.active])).toEqual(expect.arrayContaining([["MASTER", true], ["EVENT_SCHEDULE", false]]));
    expect((await eventContracts(e.org.id, e.event.id)).goLive).toBe(false);
    await db.update(schema.contracts).set({ status: "COMPLETED" }).where(eq(schema.contracts.id, e.schedule.id));
    expect((await eventContracts(e.org.id, e.event.id)).goLive).toBe(true);
    // relinking updates rather than duplicating
    await linkContract(e.actor, e.organiser.id, { contractId: e.master.id, role: "MASTER", note: "v2" });
    expect((await organiserContracts(e.org.id, e.organiser.id))).toHaveLength(2);
    const link = (await organiserContracts(e.org.id, e.organiser.id)).find((c) => c.role === "MASTER")!;
    await unlinkContract(e.actor, e.organiser.id, link.linkId);
    expect((await eventContracts(e.org.id, e.event.id)).goLive).toBe(false);
  });
});

describe("organiser account report", () => {
  it("lists payments and produces organiser and internal PDFs", async () => {
    await recordOrganiserPayment(e.actor, { mode: "test", organiserId: e.organiser.id, eventId: e.event.id, amount: 12345, currency: "eur", paymentDate: "2026-09-01", method: "BANK_TRANSFER", bankReference: "WISE-1", status: "PAID", notes: null });
    const d = await organiserReportData(e.org.id, "test", e.organiser.id, {});
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ amount: 12345, reference: "WISE-1", eventCode: e.event.code });
    for (const internal of [false, true]) {
      const pdf = await organiserReportPdf(e.org.id, "test", e.organiser.id, { internal });
      expect(pdf.bytes.subarray(0, 4).toString()).toBe("%PDF");
      expect(pdf.name).toMatch(internal ? /internal/ : /^account-report-Promo-GmbH-\d/);
    }
  });
});
