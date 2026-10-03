import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { linkPayouts, LinkPayoutsInput } from "@/server/accounting/payout-links";

/** Link several Stripe payouts to an organiser (and an event per currency) in one go. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx, mode }) => linkPayouts({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, await body(req, LinkPayoutsInput)));
