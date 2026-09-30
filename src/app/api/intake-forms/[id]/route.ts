import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { authed, body } from "@/server/http";
import { db, schema } from "@/db";
import { actorOf, tx, uuid } from "@/server/api";
import { notFound } from "@/server/errors";
import { updateIntakeDraft, validateFormVersion } from "@/server/intake/forms";
import { WORKFLOWS } from "@/server/intake/schema";

export const GET = authed<{ id: string }>("intake.view", async ({ auth, params }) => {
  const id = uuid(params.id, "Form");
  const [form] = await db.select().from(schema.intakeForms).where(and(eq(schema.intakeForms.id, id), eq(schema.intakeForms.organisationId, auth.organisationId)));
  if (!form) throw notFound("Form");
  const versions = await db.select().from(schema.intakeFormVersions).where(eq(schema.intakeFormVersions.formId, id)).orderBy(desc(schema.intakeFormVersions.version));
  const latest = versions[0];
  const validation = latest ? await validateFormVersion(auth.organisationId, latest.id) : null;
  return { form, versions: versions.map((v) => ({ id: v.id, version: v.version, published: v.published, workflow: v.workflow, publishedAt: v.publishedAt })), latest, validation: validation && { errors: validation.errors, warnings: validation.warnings, coverage: validation.coverage } };
});

export const PATCH = authed<{ id: string }>("intake.manage", async ({ req, auth, ctx, params }) => {
  const b = await body(req, z.object({ versionId: z.string().uuid(), title: z.string().trim().min(1).max(200).optional(), schema: z.unknown().optional(), settings: z.unknown().optional(), workflow: z.enum(WORKFLOWS).optional(), agreementTemplateVersionId: z.string().uuid().optional() }));
  uuid(params.id, "Form");
  return tx((t) => updateIntakeDraft(t, actorOf(auth, ctx), b.versionId, b));
});
