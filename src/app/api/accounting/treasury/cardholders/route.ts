import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { CardholderInput, createCardholder, listCardholdersAdmin } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ auth, mode }) => ({ items: await listCardholdersAdmin(auth.organisationId, mode) }));
export const POST = acct("treasury.admin", async ({ req, auth, ctx }) => createCardholder({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, await body(req, CardholderInput)));
