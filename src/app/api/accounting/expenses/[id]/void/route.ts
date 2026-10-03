import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation, uuid } from "@/server/api";
import { voidExpense } from "@/server/accounting/expenses";

/** "Delete" an expense: it is voided (kept, marked VOIDED) and its ledger entry reversed. */
export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) => {
  requireElevation(auth);
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }));
  return voidExpense({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Expense"), b.reason);
});
