import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { createDraftFromPublished } from "@/server/agreements/service";

export const POST = authed<{ id: string }>("templates.edit", async ({ auth, ctx, params }) => tx((t) => createDraftFromPublished(t, actorOf(auth, ctx), uuid(params.id, "Template"))));
