import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { createStaff, listStaff, StaffInput } from "@/server/treasury/admin";
export const GET = acct("treasury.admin", async ({ auth }) => ({ items: await listStaff(auth.organisationId) }));
export const POST = acct("treasury.admin", async ({ req, auth, ctx }) => createStaff({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, await body(req, StaffInput)));
