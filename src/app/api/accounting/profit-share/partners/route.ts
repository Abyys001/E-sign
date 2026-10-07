import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { listPartners, PartnerInput, savePartner } from "@/server/accounting/profit-share";

export const GET = acct("accounting.view", async ({ auth }) => ({ items: (await listPartners(auth.organisationId)).map((p) => ({ ...p, sharePercent: p.shareBps / 100 })) }));
export const POST = acct("accounting.admin", async ({ req, auth, ctx }) => savePartner({ orgId: auth.organisationId, userId: auth.user.id, ctx }, null, await body(req, PartnerInput)));
