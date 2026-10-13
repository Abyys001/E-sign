import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { AccountantChatInput, runAccountantChat } from "@/server/accounting/ai-accountant";

/** Bilit AI Accountant (Financial Overview): read-only questions answered from the verified calculation services. */
export const POST = acct("accounting.view", async ({ req, auth, ctx, mode }) => {
  await rateLimit("aiChat", auth.user.id);
  return runAccountantChat({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, await body(req, AccountantChatInput));
});
