import { randomUUID } from "node:crypto";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { AdjustmentInput, createAdjustment } from "@/server/accounting/manual";

/** Manual double-entry adjustment. `Idempotency-Key` makes a retried submit post once. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => {
  const key = req.headers.get("idempotency-key")?.slice(0, 80) || randomUUID();
  return createAdjustment({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, AdjustmentInput), `${auth.user.id}:${key}`);
});
