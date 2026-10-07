import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { requireElevation } from "@/server/api";
import { AgentAction, executeAction } from "@/server/accounting/agent";

/** Carry out a change the finance agent proposed and the admin confirmed (same checks as the normal screens). */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) => {
  const { action } = await body(req, z.object({ action: AgentAction }));
  if (action.kind === "void_payment") requireElevation(auth);
  return executeAction({ orgId: auth.organisationId, userId: auth.user.id, ctx }, action);
});
