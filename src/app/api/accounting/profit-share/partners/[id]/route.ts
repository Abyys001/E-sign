import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { PartnerInput, partnerOverview, savePartner } from "@/server/accounting/profit-share";

/** Partner's profit share: per event, per month, payments and balance owed (shares are brought up to date first). */
export const GET = acct<{ id: string }>("accounting.view", async ({ auth, params, mode }) => ({ ...(await partnerOverview(auth.organisationId, mode, uuid(params.id, "Partner"))), mode }));
export const PATCH = acct<{ id: string }>("accounting.admin", async ({ req, auth, ctx, params }) => savePartner({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Partner"), await body(req, PartnerInput)));
