import { acct } from "@/server/accounting/http";
import { rateLimit } from "@/server/rate-limit";
import { startAccountantCall } from "@/server/accounting/ai-call";

/** Start a live voice call with the AI Accountant: returns a short-lived OpenAI Realtime client secret. */
export const POST = acct("accounting.view", async ({ auth, ctx, mode }) => {
  await rateLimit("aiCall", auth.user.id);
  return startAccountantCall({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode);
});
