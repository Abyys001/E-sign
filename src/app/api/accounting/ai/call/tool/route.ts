import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { CallToolInput, callTool } from "@/server/accounting/ai-call";

/** A read-only lookup requested by the voice model during a call, run under the caller's own session. */
export const POST = acct("accounting.view", async ({ req, auth, ctx, mode }) => {
  await rateLimit("aiCallTool", auth.user.id);
  return callTool({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, await body(req, CallToolInput));
});
