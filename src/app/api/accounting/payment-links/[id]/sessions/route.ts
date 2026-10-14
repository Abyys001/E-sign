import { acct } from "@/server/accounting/http";
import { uuid } from "@/server/api";
import { linkSessions } from "@/server/accounting/payment-links";

/** Checkouts started from one payment link, newest first. */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params }) => linkSessions(auth.organisationId, uuid(params.id, "Payment link")));
