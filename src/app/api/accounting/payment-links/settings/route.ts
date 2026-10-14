import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { getLinkSettings, LinkSettingsInput, updateLinkSettings } from "@/server/accounting/payment-links";

/** The Stripe key payment links use to open Checkout (falls back to the import key). */
export const GET = acct("accounting.view", async ({ auth, mode }) => getLinkSettings(auth.organisationId, mode));
export const PUT = acct("accounting.admin", async ({ req, auth, ctx }) =>
  updateLinkSettings({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, LinkSettingsInput)));
