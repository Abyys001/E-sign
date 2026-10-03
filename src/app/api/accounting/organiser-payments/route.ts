import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination } from "@/server/api";
import { PaymentInput, recordOrganiserPayment } from "@/server/accounting/manual";
import { listPayments } from "@/server/accounting/queries";

const Q = Pagination.extend({ organiserId: z.string().uuid().optional(), eventId: z.string().uuid().optional(), status: z.string().max(20).optional() }).passthrough();

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  return { ...(await listPayments(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize, mode };
});

/** Record a payment Bilit made to an organiser; reduces the organiser's outstanding balance via its own ledger entry. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => recordOrganiserPayment({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, PaymentInput)));
