import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { LinkInput, linkRecipient, listRecipients } from "@/server/accounting/stripe-payouts";

/** Stripe Global Payouts recipients (created in the Stripe Dashboard) and linking them to organisers / partners. */
export const GET = acct("accounting.manage", async ({ auth, mode }) => ({ items: await listRecipients(auth.organisationId, mode) }));
export const PUT = acct("accounting.admin", async ({ req, auth, ctx }) => linkRecipient({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, LinkInput)));
