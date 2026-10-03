import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { AppError } from "@/server/errors";
import { AgreementInput, createEvent, EventInput, updateEvent } from "@/server/accounting/entities";
import { rematchUnmatched } from "@/server/accounting/manual";

const Input = z.object({
  link: z.array(z.string().uuid()).max(200).default([]),
  create: z.array(EventInput.pick({ code: true, name: true, currency: true })).max(200).default([]),
  agreement: AgreementInput,
}).refine((b) => b.link.length + b.create.length > 0, { message: "Choose at least one event", path: ["create"] });

/** Link existing events to this organiser and/or create events for detected Stripe codes under it; then re-match sales. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  const organiserId = uuid(params.id, "Organiser");
  const b = await body(req, Input);
  const actor = { orgId: auth.organisationId, userId: auth.user.id, ctx };
  const [o] = await db.select({ id: schema.acctOrganisers.id }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, organiserId), eq(schema.acctOrganisers.organisationId, auth.organisationId)));
  if (!o) throw new AppError("not_found", "Organiser not found");
  if (b.link.length) {
    const evs = await db.select({ id: schema.acctEvents.id }).from(schema.acctEvents).where(and(eq(schema.acctEvents.organisationId, auth.organisationId), inArray(schema.acctEvents.id, b.link)));
    for (const e of evs) await updateEvent(actor, e.id, { organiserId, reason: "Linked to organiser" });
  }
  const created: string[] = [];
  for (const c of b.create) created.push((await createEvent(actor, { ...c, organiserId, startsOn: null, status: "ACTIVE", notes: null, agreement: b.agreement })).id);
  return { linked: b.link.length, created: created.length, rematch: await rematchUnmatched(auth.organisationId, { userId: auth.user.id }) };
});
