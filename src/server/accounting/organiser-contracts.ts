import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { acctAudit } from "./core";

type Actor = { orgId: string; userId: string; ctx: RequestContext };

/** "Active" in the promoter brief = the contract is fully signed (COMPLETED). */
export const contractActive = (status: string) => status === "COMPLETED";

export const LinkContract = z.object({
  contractId: z.string().uuid(),
  eventId: z.string().uuid().nullish(),
  role: z.enum(["MASTER", "EVENT_SCHEDULE", "OTHER"]).default("OTHER"),
  note: z.string().trim().max(500).nullish(),
});

const cols = {
  linkId: schema.acctOrganiserContracts.id, contractId: schema.contracts.id, reference: schema.contracts.reference, name: schema.contracts.name,
  status: schema.contracts.status, sentAt: schema.contracts.sentAt, completedAt: schema.contracts.completedAt, createdAt: schema.contracts.createdAt,
  role: schema.acctOrganiserContracts.role, note: schema.acctOrganiserContracts.note, eventId: schema.acctOrganiserContracts.eventId,
  eventName: schema.acctEvents.name, eventCode: schema.acctEvents.code, organiserId: schema.acctOrganiserContracts.organiserId, linkedAt: schema.acctOrganiserContracts.createdAt,
};
const base = () => db.select(cols).from(schema.acctOrganiserContracts)
  .innerJoin(schema.contracts, eq(schema.contracts.id, schema.acctOrganiserContracts.contractId))
  .leftJoin(schema.acctEvents, eq(schema.acctEvents.id, schema.acctOrganiserContracts.eventId));
const shape = <T extends { status: string }>(r: T) => ({ ...r, active: contractActive(r.status) });

export async function organiserContracts(orgId: string, organiserId: string) {
  const rows = await base().where(and(eq(schema.acctOrganiserContracts.organisationId, orgId), eq(schema.acctOrganiserContracts.organiserId, organiserId), isNull(schema.contracts.deletedAt)))
    .orderBy(desc(schema.acctOrganiserContracts.createdAt));
  return rows.map(shape);
}

/**
 * Contract status for an event: an event-specific contract (Event Schedule) plus the organiser's master agreement.
 * `goLive` is true only when both an active master and an active event schedule exist (or an active contract linked to the event).
 */
export async function eventContracts(orgId: string, eventId: string) {
  const [ev] = await db.select({ organiserId: schema.acctEvents.organiserId }).from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, orgId)));
  if (!ev) throw new AppError("not_found", "Event not found");
  const rows = (await base().where(and(eq(schema.acctOrganiserContracts.organisationId, orgId), isNull(schema.contracts.deletedAt),
    or(eq(schema.acctOrganiserContracts.eventId, eventId), ev.organiserId ? and(eq(schema.acctOrganiserContracts.organiserId, ev.organiserId), eq(schema.acctOrganiserContracts.role, "MASTER")) : undefined)))
    .orderBy(desc(schema.acctOrganiserContracts.createdAt))).map(shape);
  const master = rows.find((r) => r.role === "MASTER" && r.active);
  const forEvent = rows.find((r) => r.eventId === eventId && r.active);
  return { items: rows, goLive: !!forEvent && (!!master || forEvent.role !== "EVENT_SCHEDULE") };
}

/** Contracts that can be linked: search by reference, name or recipient (search_text). */
export async function contractCandidates(orgId: string, q: string | undefined) {
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return db.select({ id: schema.contracts.id, reference: schema.contracts.reference, name: schema.contracts.name, status: schema.contracts.status, createdAt: schema.contracts.createdAt })
    .from(schema.contracts)
    .where(and(eq(schema.contracts.organisationId, orgId), isNull(schema.contracts.deletedAt), like ? or(ilike(schema.contracts.searchText, like), ilike(schema.contracts.reference, like)) : undefined))
    .orderBy(desc(schema.contracts.createdAt)).limit(25);
}

export async function linkContract(a: Actor, organiserId: string, input: z.infer<typeof LinkContract>) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select({ id: schema.acctOrganisers.id }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, organiserId), eq(schema.acctOrganisers.organisationId, a.orgId)));
    if (!o) throw new AppError("not_found", "Organiser not found");
    const [c] = await tx.select({ id: schema.contracts.id, reference: schema.contracts.reference }).from(schema.contracts).where(and(eq(schema.contracts.id, input.contractId), eq(schema.contracts.organisationId, a.orgId), isNull(schema.contracts.deletedAt)));
    if (!c) throw new AppError("validation_failed", "Contract not found.", [{ path: "contractId", message: "Not found" }]);
    if (input.eventId) {
      const [e] = await tx.select({ organiserId: schema.acctEvents.organiserId }).from(schema.acctEvents).where(and(eq(schema.acctEvents.id, input.eventId), eq(schema.acctEvents.organisationId, a.orgId)));
      if (!e) throw new AppError("validation_failed", "Event not found.", [{ path: "eventId", message: "Not found" }]);
      if (e.organiserId && e.organiserId !== organiserId) throw new AppError("validation_failed", "That event belongs to another organiser.", [{ path: "eventId", message: "Other organiser" }]);
    }
    if (input.role === "EVENT_SCHEDULE" && !input.eventId) throw new AppError("validation_failed", "Choose the event this Event Schedule is for.", [{ path: "eventId", message: "Required" }]);
    const [row] = await tx.insert(schema.acctOrganiserContracts).values({ organisationId: a.orgId, organiserId, contractId: c.id, eventId: input.eventId ?? null, role: input.role, note: input.note ?? null, createdBy: a.userId })
      .onConflictDoUpdate({ target: [schema.acctOrganiserContracts.organiserId, schema.acctOrganiserContracts.contractId], set: { eventId: input.eventId ?? null, role: input.role, note: input.note ?? null } }).returning();
    await acctAudit(tx, { ...a, action: "organiser.contract_linked", entity: "organiser", entityId: organiserId, new: { contractId: c.id, reference: c.reference, eventId: input.eventId ?? null, role: input.role } });
    return row!;
  });
}

export async function unlinkContract(a: Actor, organiserId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const del = await tx.delete(schema.acctOrganiserContracts).where(and(eq(schema.acctOrganiserContracts.id, linkId), eq(schema.acctOrganiserContracts.organiserId, organiserId), eq(schema.acctOrganiserContracts.organisationId, a.orgId))).returning();
    if (!del.length) throw new AppError("not_found", "Link not found");
    await acctAudit(tx, { ...a, action: "organiser.contract_unlinked", entity: "organiser", entityId: organiserId, old: { contractId: del[0]!.contractId, eventId: del[0]!.eventId, role: del[0]!.role } });
    return { unlinked: true };
  });
}

/** Linked contracts for many organisers at once (for reports). */
export async function contractsForOrganisers(orgId: string, organiserIds: string[]) {
  if (!organiserIds.length) return [];
  return (await base().where(and(eq(schema.acctOrganiserContracts.organisationId, orgId), inArray(schema.acctOrganiserContracts.organiserId, organiserIds), isNull(schema.contracts.deletedAt)))).map(shape);
}
