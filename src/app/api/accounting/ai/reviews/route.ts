import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { IsoDate } from "@/server/accounting/core";
import { listAiReviews, runAiReview } from "@/server/accounting/ai";

export const GET = acct("accounting.view", async ({ auth }) => ({ items: await listAiReviews(auth.organisationId) }));

/** Run an AI bookkeeping review of a period (sends an anonymised digest to OpenAI). */
export const POST = acct("accounting.manage", async ({ req, auth, ctx, mode }) => {
  const b = await body(req, z.object({ from: IsoDate, to: IsoDate }));
  await rateLimit("accountingExport", auth.user.id);
  return runAiReview({ orgId: auth.organisationId, userId: auth.user.id, ctx }, mode, b);
});
