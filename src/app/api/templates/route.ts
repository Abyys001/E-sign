import { z } from "zod";
import { authed, query } from "@/server/http";
import { actorOf, tx } from "@/server/api";
import { AppError } from "@/server/errors";
import { createTemplate, listTemplates } from "@/server/templates/service";

export const GET = authed("templates.view", async ({ req, auth }) => ({ items: await listTemplates(auth.organisationId, query(req, z.object({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional() })).status) }));

export const POST = authed("templates.create", async ({ req, auth, ctx }) => {
  const form = await req.formData().catch(() => { throw new AppError("bad_request", "Send the template as multipart form data."); });
  const name = z.string().trim().min(1).max(200).parse(form.get("name"));
  const file = form.get("file");
  const pdf = file instanceof File ? Buffer.from(await file.arrayBuffer()) : undefined;
  const r = await tx((t) => createTemplate(t, actorOf(auth, ctx), { name, contractType: typeof form.get("contractType") === "string" ? String(form.get("contractType")).slice(0, 60) : undefined, pdf }));
  return Response.json({ id: r.template.id, version: r.version.version }, { status: 201 });
});
