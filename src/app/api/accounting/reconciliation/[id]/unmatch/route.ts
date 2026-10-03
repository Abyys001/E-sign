import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { uuid } from "@/server/api";
import { unmatchTransaction } from "@/server/accounting/manual";

export const POST = acct<{ id: string }>("accounting.manage", async ({ req, auth, ctx, params }) =>
  unmatchTransaction({ orgId: auth.organisationId, userId: auth.user.id, ctx }, uuid(params.id, "Transaction"), (await body(req, z.object({ reason: z.string().trim().min(3).max(1000) }))).reason));
