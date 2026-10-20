import { authed, body } from "@/server/http";
import { EnrolInput, enrolPhone } from "@/server/accounting/phone";

/** Set up this browser as the phone app while signed in: password (or 2FA code) again + a new 6-digit PIN. */
export const POST = authed(null, async ({ req, auth, ctx }) => enrolPhone(auth, ctx, await body(req, EnrolInput)));
