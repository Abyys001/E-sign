import { z } from "zod";
import { authed, body } from "@/server/http";
import { actorOf, tx } from "@/server/api";
import { createAgreementTemplate, listAgreementTemplates } from "@/server/agreements/service";

export const GET = authed("templates.view", async ({ auth }) => ({ items: await listAgreementTemplates(auth.organisationId) }));
export const POST = authed("templates.create", async ({ req, auth, ctx }) => {
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(200), agreementType: z.string().max(60), jurisdiction: z.string().max(20), language: z.enum(["en", "fa"]).optional() }));
  const r = await tx((t) => createAgreementTemplate(t, actorOf(auth, ctx), b));
  return Response.json({ id: r.template.id, versionId: r.version.id, unavailableClauses: r.unavailableClauses }, { status: 201 });
});
