import { body, open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { CallToolInput, callTool } from "@/server/accounting/ai-call";
import { requirePhone } from "@/server/accounting/phone";

/** Phone app: a read-only lookup requested by the voice model during a call. */
export const POST = open(async ({ req, ctx }) => {
  const a = await requirePhone(req, ctx);
  await rateLimit("aiCallTool", a.userId);
  return callTool(a, a.mode, await body(req, CallToolInput));
});
