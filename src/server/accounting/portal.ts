import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { acctAudit, accountingEnabled } from "./core";
import { organiserFinancials, type Figures } from "./finance";

type Actor = { orgId: string; userId: string; ctx: RequestContext };

/** Organisers a user may see in the organiser portal (their own figures only). */
export async function linkedOrganisers(orgId: string, userId: string) {
  if (!accountingEnabled()) return [];
  return db.select({ id: schema.acctOrganisers.id, name: schema.acctOrganisers.name }).from(schema.acctOrganiserUsers)
    .innerJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, schema.acctOrganiserUsers.organiserId))
    .where(and(eq(schema.acctOrganiserUsers.organisationId, orgId), eq(schema.acctOrganiserUsers.userId, userId)));
}

/** What an organiser may see: their money, never Bilit's margin, costs or internal notes. */
const organiserSafe = (f: Figures) => ({
  currency: f.currency, tickets: f.tickets, orders: f.orders, grossSales: f.grossSales, refunds: f.refunds, chargebacks: f.chargebacks, netSales: f.netSales,
  bookingFees: f.bookingFees, eventFees: f.eventFees, feesRecharged: f.feesRecharged, deductions: f.deductions, expensesOrganiser: f.expensesOrganiser,
  organiserDue: f.organiserDue, organiserPaid: f.organiserPaid, remaining: f.remaining, pendingPayments: f.pendingPayments, settlement: f.settlement,
});

/** Organiser portal: live data only (test-mode activity is never shown to organisers). */
export async function portalData(orgId: string, userId: string) {
  const orgs = await linkedOrganisers(orgId, userId);
  if (!orgs.length) throw new AppError("forbidden", "Your account is not linked to an organiser.");
  const ids = orgs.map((o) => o.id);
  const [fin, payments] = await Promise.all([
    Promise.all(orgs.map(async (o) => ({ o, f: await organiserFinancials(orgId, "live", o.id) }))),
    db.select({ p: schema.acctOrganiserPayments, eventName: schema.acctEvents.name }).from(schema.acctOrganiserPayments).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, schema.acctOrganiserPayments.eventId))
      .where(and(eq(schema.acctOrganiserPayments.organisationId, orgId), eq(schema.acctOrganiserPayments.livemode, true), inArray(schema.acctOrganiserPayments.organiserId, ids)))
      .orderBy(desc(schema.acctOrganiserPayments.paymentDate)).limit(500),
  ]);
  return {
    organisers: fin.map(({ o, f }) => ({
      id: o.id, name: o.name, eventCount: f.eventCount, totals: f.totals.map(organiserSafe),
      events: f.events.map((e) => ({ eventId: e.eventId, eventName: e.eventName, eventCode: e.eventCode, startsOn: e.startsOn, bookingFeeBps: e.bookingFeeBps, ...organiserSafe(e) })),
    })),
    payments: payments.filter((r) => r.p.status !== "VOIDED").map((r) => ({ id: r.p.id, organiserId: r.p.organiserId, eventName: r.eventName, amount: r.p.amount, currency: r.p.currency, paymentDate: r.p.paymentDate, method: r.p.method, reference: r.p.bankReference, status: r.p.status })),
  };
}

// ---------- admin: link users to organisers ----------
export async function organiserUsers(orgId: string, organiserId: string) {
  const [linked, members] = await Promise.all([
    db.select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, createdAt: schema.acctOrganiserUsers.createdAt }).from(schema.acctOrganiserUsers)
      .innerJoin(schema.users, eq(schema.users.id, schema.acctOrganiserUsers.userId)).where(and(eq(schema.acctOrganiserUsers.organisationId, orgId), eq(schema.acctOrganiserUsers.organiserId, organiserId))),
    db.select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, roleKey: schema.memberships.roleKey }).from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.organisationId, orgId)),
  ]);
  return { linked, members };
}

export async function linkOrganiserUser(a: Actor, organiserId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select({ id: schema.acctOrganisers.id }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, organiserId), eq(schema.acctOrganisers.organisationId, a.orgId)));
    if (!o) throw new AppError("not_found", "Organiser not found");
    const [m] = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.organisationId, a.orgId), eq(schema.memberships.userId, userId)));
    if (!m) throw new AppError("validation_failed", "That user is not a member of this organisation. Invite them first.", [{ path: "userId", message: "Not a member" }]);
    const ins = await tx.insert(schema.acctOrganiserUsers).values({ organiserId, userId, organisationId: a.orgId, createdBy: a.userId }).onConflictDoNothing().returning();
    if (ins.length) await acctAudit(tx, { ...a, action: "organiser.portal_user_linked", entity: "organiser", entityId: organiserId, new: { userId } });
    return { linked: ins.length > 0 };
  });
}

export async function unlinkOrganiserUser(a: Actor, organiserId: string, userId: string) {
  return db.transaction(async (tx) => {
    const del = await tx.delete(schema.acctOrganiserUsers).where(and(eq(schema.acctOrganiserUsers.organisationId, a.orgId), eq(schema.acctOrganiserUsers.organiserId, organiserId), eq(schema.acctOrganiserUsers.userId, userId))).returning();
    if (!del.length) throw new AppError("not_found", "That user is not linked to this organiser.");
    await acctAudit(tx, { ...a, action: "organiser.portal_user_unlinked", entity: "organiser", entityId: organiserId, old: { userId } });
    return { ok: true };
  });
}
