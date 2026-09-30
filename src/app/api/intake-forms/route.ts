import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx } from "@/server/api";
import { createIntakeForm, listIntakeForms } from "@/server/intake/forms";
import { WORKFLOWS } from "@/server/intake/schema";

export const GET = authed("intake.view", async ({ auth }) => ({ items: await listIntakeForms(auth.organisationId) }));
export const POST = authed("intake.manage", async ({ req, auth, ctx }) => {
  const b = await body(req, z.object({ title: z.string().trim().min(1).max(200), agreementTemplateVersionId: z.string().uuid(), workflow: z.enum(WORKFLOWS).optional(), settings: z.unknown().optional() }));
  const r = await tx((t) => createIntakeForm(t, actorOf(auth, ctx), b));
  return Response.json({ id: r.form.id, versionId: r.version.id }, { status: 201 });
});
