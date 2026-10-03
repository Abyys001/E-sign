import { rematchUnmatched } from "@/server/accounting/manual";
import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination } from "@/server/api";
import { createEvent, EventInput } from "@/server/accounting/entities";
import { listEvents } from "@/server/accounting/queries";

const Q = Pagination.extend({ q: z.string().trim().max(120).optional(), organiserId: z.string().uuid().optional(), status: z.string().max(20).optional() }).passthrough();

export const GET = acct("accounting.view", async ({ req, auth }) => {
  const q = query(req, Q);
  return { ...(await listEvents(auth.organisationId, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize };
});

export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => {
  const ev = await createEvent({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, EventInput));
  return { ...ev, rematch: await rematchUnmatched(auth.organisationId, { userId: auth.user.id }) }; // already-imported sales with this code are matched now
});
