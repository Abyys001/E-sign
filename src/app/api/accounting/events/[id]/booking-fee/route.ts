import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { BookingFeeInput, setBookingFee } from "@/server/accounting/manual";

/** Change the event's booking fee %; optionally re-apply it to sales already booked (reversal + re-post). */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  setBookingFee({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Event"), await body(req, BookingFeeInput)));
