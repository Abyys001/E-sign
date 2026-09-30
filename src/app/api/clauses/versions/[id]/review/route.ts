import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { setClauseReviewStatus } from "@/server/clauses/service";

// Approving legal text is an organisation-level decision, so it needs settings.manage rather than plain template editing.
export const POST = authed<{ id: string }>("settings.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ reviewStatus: z.enum(["unreviewed", "in_review", "approved"]) }));
  return tx((t) => setClauseReviewStatus(t, actorOf(auth, ctx), uuid(params.id, "Clause version"), b.reviewStatus));
});
