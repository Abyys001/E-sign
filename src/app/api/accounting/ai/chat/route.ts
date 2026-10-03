import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { ChatInput, runChat } from "@/server/accounting/ai";

/** Ask the AI finance assistant a question about the books (payments, profits, refunds, settlement). */
export const POST = acct("accounting.view", async ({ req, auth, ctx, mode }) => {
  await rateLimit("aiChat", auth.user.id);
  return runChat({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, await body(req, ChatInput));
});
