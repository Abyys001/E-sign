import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { isLive, type Mode } from "./core";
import { recordOrganiserPayment } from "./manual";

type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const LinkPayoutsInput = z.object({
  payoutIds: z.array(z.string().min(3).max(60)).min(1).max(100),
  organiserId: z.string().uuid(),
  eventByCurrency: z.record(z.string().regex(/^[a-z]{3}$/), z.string().uuid().nullable()).default({}), // optional event per currency
  notes: z.string().trim().max(500).optional().nullable(),
});

/**
 * Link several Stripe payouts to one organiser at once: each payout becomes its own organiser payment (amount, arrival
 * date, payout id as reference, method Stripe), optionally on an event of the matching currency. Payouts that are
 * already linked, failed or cancelled are skipped, so a payout is never counted twice.
 */
export async function linkPayouts(a: Actor, mode: Mode, input: z.infer<typeof LinkPayoutsInput>) {
  const p = schema.stripePayouts;
  const payouts = await db.select().from(p).where(and(eq(p.organisationId, a.orgId), eq(p.livemode, isLive(mode)), inArray(p.payoutId, input.payoutIds)));
  if (!payouts.length) throw new AppError("validation_failed", "None of the selected payouts were found.", [{ path: "payoutIds", message: "Not found" }]);
  const linked = await db.select({ ref: schema.acctOrganiserPayments.bankReference }).from(schema.acctOrganiserPayments)
    .where(and(eq(schema.acctOrganiserPayments.organisationId, a.orgId), eq(schema.acctOrganiserPayments.livemode, isLive(mode)), inArray(schema.acctOrganiserPayments.bankReference, input.payoutIds), sql_notVoided()));
  const already = new Set(linked.map((l) => l.ref));
  const created: string[] = [], skipped: Array<{ payoutId: string; reason: string }> = [];
  for (const po of payouts) {
    if (already.has(po.payoutId)) { skipped.push({ payoutId: po.payoutId, reason: "already linked" }); continue; }
    if (["failed", "canceled"].includes(po.status)) { skipped.push({ payoutId: po.payoutId, reason: po.status }); continue; }
    const eventId = input.eventByCurrency[po.currency] ?? null;
    await recordOrganiserPayment(a, {
      mode, organiserId: input.organiserId, eventId, amount: po.amount, currency: po.currency, paymentDate: (po.arrivalDate ?? po.stripeCreatedAt).toISOString().slice(0, 10),
      bankReference: po.payoutId, method: "STRIPE_TRANSFER", status: "PAID", notes: input.notes ?? "Paid out through Stripe",
    });
    created.push(po.payoutId);
  }
  return { created: created.length, skipped };
}
const sql_notVoided = () => inArray(schema.acctOrganiserPayments.status, ["PAID", "PENDING"]);
