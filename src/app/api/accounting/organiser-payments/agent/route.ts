import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { AgentInput, analysePaymentText } from "@/server/accounting/payment-agent";

/** AI payment agent: turn a typed/pasted instruction into checked organiser-payment proposals (nothing is posted). */
export const POST = acct("accounting.manage", async ({ req, auth, ctx, mode }) => {
  const b = await body(req, AgentInput);
  await rateLimit("aiChat", auth.user.id);
  return analysePaymentText({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, b);
});
