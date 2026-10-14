import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { CardInput, createCard, listCardsAdmin } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ auth, mode }) => ({ items: await listCardsAdmin(auth.organisationId, mode) }));
export const POST = acct("treasury.admin", async ({ req, auth, ctx }) => { requireElevation(auth); return createCard({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, await body(req, CardInput)); });
