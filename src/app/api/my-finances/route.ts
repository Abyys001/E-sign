import { authed } from "@/server/http";
import { requireAccounting } from "@/server/accounting/core";
import { portalData } from "@/server/accounting/portal";

/** Organiser portal: the signed-in user's own organiser figures (live data only). No accounting permission needed. */
export const GET = authed(null, async ({ auth }) => {
  requireAccounting();
  return portalData(auth.organisationId, auth.user.id);
});
