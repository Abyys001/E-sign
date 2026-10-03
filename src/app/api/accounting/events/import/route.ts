import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { AgreementInput, createEvent, EventInput } from "@/server/accounting/entities";
import { rematchUnmatched } from "@/server/accounting/manual";

const Input = z.object({
  events: z.array(EventInput.pick({ code: true, name: true, currency: true }).extend({ organiserId: z.string().uuid().nullable().optional() })).min(1).max(200),
  agreement: AgreementInput,
});

/** Create events from event codes detected in imported Stripe transactions; their sales are matched straight away. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => {
  const b = await body(req, Input);
  const actor = { orgId: auth.organisationId, userId: auth.user.id, ctx };
  for (const e of b.events) await createEvent(actor, { ...e, organiserId: e.organiserId ?? null, startsOn: null, status: "ACTIVE", notes: null, agreement: b.agreement });
  return { created: b.events.length, rematch: await rematchUnmatched(auth.organisationId, { userId: auth.user.id }) };
});
