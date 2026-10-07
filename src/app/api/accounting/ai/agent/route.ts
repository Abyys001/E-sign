import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { AgentChatInput, runAgentChat } from "@/server/accounting/agent";

/** Chat with the finance agent: it looks things up with read-only tools and may propose changes (never executes them). */
export const POST = acct("accounting.view", async ({ req, auth, ctx, mode }) => {
  await rateLimit("aiChat", auth.user.id);
  return runAgentChat({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, await body(req, AgentChatInput));
});
