import { authed } from "@/server/http";
import { actorOf, tx, uuid } from "@/server/api";
import { deleteTemplate, getTemplate } from "@/server/templates/service";

export const GET = authed<{ id: string }>("templates.view", async ({ auth, params }) => getTemplate(auth.organisationId, uuid(params.id, "Template")));
export const DELETE = authed<{ id: string }>("templates.delete", async ({ auth, ctx, params }) => { await tx((t) => deleteTemplate(t, actorOf(auth, ctx), uuid(params.id, "Template"))); return { ok: true }; });
