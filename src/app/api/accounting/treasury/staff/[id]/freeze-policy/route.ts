import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { setStaffFreezePolicy } from "@/server/treasury/admin";
export const POST = acct<{ id: string }>("treasury.admin", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ canFreeze: z.boolean() }));
  return setStaffFreezePolicy({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, uuid(params.id, "Staff"), b.canFreeze);
});
