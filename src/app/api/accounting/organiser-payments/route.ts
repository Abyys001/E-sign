import { z } from "zod";
import { acct, csvResponse } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination, requireElevation } from "@/server/api";
import { rateLimit } from "@/server/rate-limit";
import { csvStream, paged, type CsvColumn } from "@/server/accounting/reports";
import { PaymentInput, recordOrganiserPayment } from "@/server/accounting/manual";
import { listPayments } from "@/server/accounting/queries";

const Q = Pagination.extend({ organiserId: z.string().uuid().optional(), eventId: z.string().uuid().optional(), status: z.string().max(20).optional(), format: z.enum(["csv"]).optional() }).passthrough();
type P = Awaited<ReturnType<typeof listPayments>>["items"][number];
const COLS: CsvColumn<P>[] = [
  { header: "payment_date", value: (r) => r.paymentDate }, { header: "organiser", value: (r) => r.organiserName }, { header: "event", value: (r) => r.eventName }, { header: "event_code", value: (r) => r.eventCode },
  { header: "amount", value: (r) => r.amount, money: (r) => r.currency }, { header: "currency", value: (r) => r.currency.toUpperCase() }, { header: "method", value: (r) => r.method }, { header: "reference", value: (r) => r.bankReference },
  { header: "status", value: (r) => r.status }, { header: "notes", value: (r) => r.notes }, { header: "void_reason", value: (r) => r.voidReason }, { header: "recorded_by", value: (r) => r.createdByName }, { header: "recorded_at", value: (r) => r.createdAt },
];

export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  if (q.format) {
    requireElevation(auth); await rateLimit("accountingExport", auth.user.id);
    return csvResponse(csvStream(COLS, paged(async (limit, offset) => (await listPayments(auth.organisationId, mode, q, { limit, offset })).items)), `organiser-payments-${mode}`);
  }
  return { ...(await listPayments(auth.organisationId, mode, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })), page: q.page, pageSize: q.pageSize, mode };
});

/** Record a payment Bilit made to an organiser; reduces the organiser's outstanding balance via its own ledger entry. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => recordOrganiserPayment({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, PaymentInput)));
