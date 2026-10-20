import { open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { startAccountantCall } from "@/server/accounting/ai-call";
import { requirePhone } from "@/server/accounting/phone";

/** Phone app: start a call (same as the finance call page, under the unlocked phone session). */
export const POST = open(async ({ req, ctx }) => {
  const a = await requirePhone(req, ctx);
  await rateLimit("aiCall", a.userId);
  return startAccountantCall(a, a.mode);
});
