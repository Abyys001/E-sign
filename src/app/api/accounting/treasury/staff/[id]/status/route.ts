import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { setStaffStatus } from "@/server/treasury/admin";
export const POST = acct<{ id: string }>("treasury.admin", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]) }));
  if (b.status === "REVOKED") requireElevation(auth);
  return setStaffStatus({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, uuid(params.id, "Staff"), b.status);
});
