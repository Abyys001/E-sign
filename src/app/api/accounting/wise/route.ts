import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { ConnectInput, ProfileInput, connectWise, disconnectWise, getWiseStatus, setWiseProfile } from "@/server/accounting/wise";

/** Wise bank feed connection. The API token is write-only (only a masked hint is returned). */
export const GET = acct("accounting.view", async ({ auth }) => getWiseStatus(auth.organisationId));
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => {
  requireElevation(auth);
  return connectWise({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, ConnectInput));
});
export const PATCH = acct("accounting.admin", async ({ req, auth, ctx }) => setWiseProfile({ orgId: auth.organisationId, userId: auth.user.id, ctx }, (await body(req, ProfileInput)).profileId));
export const DELETE = acct("accounting.admin", async ({ auth, ctx }) => {
  requireElevation(auth);
  return disconnectWise({ orgId: auth.organisationId, userId: auth.user.id, ctx });
});
