import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { createLink, LinkInput, listLinks } from "@/server/accounting/payment-links";

/** Branded payment links (public /pay/<slug> pages that open Stripe Checkout) for the current mode. */
export const GET = acct("accounting.view", async ({ auth, mode }) => listLinks(auth.organisationId, mode));
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) =>
  createLink({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, LinkInput)));
