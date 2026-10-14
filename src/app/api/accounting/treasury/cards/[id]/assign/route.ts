import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { assignCard } from "@/server/treasury/admin";
export const POST = acct<{ id: string }>("treasury.admin", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ staffId: z.string().uuid() }));
  return assignCard({ orgId: auth.organisationId, userId: auth.user.id, userName: auth.user.name, ctx }, b.staffId, uuid(params.id, "Card"));
});
