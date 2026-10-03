import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { IsoDate } from "@/server/accounting/core";
import { editOrganiserPayment, markPaymentPaid, PaymentEdit } from "@/server/accounting/manual";

/** One payment with its ledger entries (original, reversals, re-posts) and its audit history. */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => {
  const id = uuid(params.id, "Payment");
  const p = schema.acctOrganiserPayments;
  const [r] = await db.select({ p, organiserName: schema.acctOrganisers.name, eventName: schema.acctEvents.name, eventCode: schema.acctEvents.code }).from(p)
    .innerJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, p.organiserId)).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, p.eventId))
    .where(and(eq(p.id, id), eq(p.organisationId, auth.organisationId)));
  if (!r) throw new AppError("not_found", "Payment not found");
  const e = schema.acctJournalEntries;
  const entries = await db.select({ id: e.id, seq: e.seq, entryDate: e.entryDate, entryType: e.entryType, description: e.description, status: e.status, reason: e.reason, createdAt: e.createdAt }).from(e)
    .where(and(eq(e.organisationId, auth.organisationId), eq(e.sourceType, "organiser_payment"), eq(e.sourceId, id))).orderBy(asc(e.seq));
  const history = await db.execute<{ event_type: string; occurred_at: Date; metadata: Record<string, unknown>; user_name: string | null }>(sql`
    select a.event_type, a.occurred_at, a.metadata, u.name as user_name from audit_events a left join users u on u.id = a.user_id
    where a.organisation_id = ${auth.organisationId} and a.contract_id is null and a.event_type like 'accounting.organiser_payment.%' and a.metadata->>'entityId' = ${id} order by a.occurred_at desc`);
  const users = [r.p.createdBy, r.p.updatedBy, r.p.voidedBy].filter((x): x is string => !!x);
  const names = users.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, users)) : [];
  const nm = (u: string | null) => names.find((x) => x.id === u)?.name ?? null;
  return {
    payment: { ...r.p, organiserName: r.organiserName, eventName: r.eventName, eventCode: r.eventCode, createdByName: nm(r.p.createdBy), updatedByName: nm(r.p.updatedBy), voidedByName: nm(r.p.voidedBy) },
    entries, history: history.rows.map((h) => ({ type: h.event_type.replace(/^accounting\./, ""), at: h.occurred_at, userName: h.user_name, metadata: h.metadata })),
  };
});

/** `{status: "PAID"}` marks a pending payment as paid; any other body edits the payment (with a reason). */
export const PATCH = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const a = { orgId: auth.organisationId, userId: auth.user.id, ctx };
  const b = await body(req, z.union([z.object({ status: z.literal("PAID"), paymentDate: IsoDate.optional() }), PaymentEdit]));
  return "status" in b ? markPaymentPaid(a, uuid(params.id, "Payment"), b.paymentDate) : editOrganiserPayment(a, uuid(params.id, "Payment"), b);
});
