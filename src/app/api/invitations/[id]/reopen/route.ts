import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { reopenSubmission } from "@/server/intake/invitations";

export const POST = authed<{ id: string }>("intake.send", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ reason: z.string().trim().min(3).max(300) }));
  return tx((t) => reopenSubmission(t, actorOf(auth, ctx), uuid(params.id, "Invitation"), b.reason));
});
