import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { createFormDraftFromPublished } from "@/server/intake/forms";

export const POST = authed<{ id: string }>("intake.manage", async ({ auth, ctx, params }) => tx((t) => createFormDraftFromPublished(t, actorOf(auth, ctx), uuid(params.id, "Form"))));
