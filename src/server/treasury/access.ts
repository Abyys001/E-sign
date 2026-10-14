import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError } from "../errors";
import { modeOf, type Mode } from "../accounting/core";
import type { StaffContext } from "./auth";
import { logTreasury } from "./audit";

/**
 * The one place staff access to a card is decided. Every staff request must pass through `authorizeCard`: it resolves
 * the card from the DB by the staff's own active assignment, never from an id supplied by the browser, and returns the
 * stored card row and the start of the staff's assignment. A card id in the URL is only ever used to *select among the staff's own cards* — it can never widen
 * access. A denied attempt is audited.
 */
export type StaffCard = typeof schema.treasuryCards.$inferSelect;

/** All cards currently assigned to this staff member (active assignments only). */
export async function assignedCards(staffId: string): Promise<StaffCard[]> {
  return (await assignments(staffId)).map((r) => r.c);
}
async function assignments(staffId: string) {
  return db.select({ c: schema.treasuryCards, assignedAt: schema.treasuryAssignments.assignedAt })
    .from(schema.treasuryAssignments)
    .innerJoin(schema.treasuryCards, eq(schema.treasuryCards.id, schema.treasuryAssignments.cardId))
    .where(and(eq(schema.treasuryAssignments.staffId, staffId), isNull(schema.treasuryAssignments.revokedAt)));
}

/**
 * Authorise one card for a staff member. `cardId` (from the request) is optional: with it, the card must be among the
 * staff's assigned cards; without it, the single assigned card is used. Returns the card row and the mode it lives in.
 * Throws 403 (audited) on any mismatch — tampering with the id cannot reach another staff's card.
 */
export async function authorizeCard(sc: StaffContext, cardId?: string | null): Promise<{ card: StaffCard; mode: Mode; since: Date }> {
  const rows = await assignments(sc.staff.id);
  const hit = cardId ? rows.find((r) => r.c.id === cardId) : rows[0];
  const card = hit?.c;
  if (!card) {
    await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "card.access", resource: "card", resourceId: cardId ?? null, outcome: "DENY", ip: sc.ctx.ip, metadata: { reason: cardId ? "not_assigned" : "no_card" } });
    throw new AppError("forbidden", "You do not have access to that card.");
  }
  // defence in depth: the assignment and the card must belong to the staff's own organisation
  if (card.organisationId !== sc.staff.organisationId) {
    await logTreasury(db, { orgId: sc.staff.organisationId, actorType: "STAFF", actorId: sc.staff.id, actorName: sc.staff.name, action: "card.access", resource: "card", resourceId: card.id, outcome: "DENY", ip: sc.ctx.ip, metadata: { reason: "cross_org" } });
    throw new AppError("forbidden", "You do not have access to that card.");
  }
  // `since` = when this staff's assignment began: a card that changed hands never shows the previous holder's activity
  return { card, mode: modeOf(card.livemode), since: hit!.assignedAt };
}
