import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { voidBill } from "@/server/accounting/books";

/** "Delete": the document is kept, marked VOIDED, and its ledger entries reversed. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }));
  return voidBill({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Document"), b.reason);
});
