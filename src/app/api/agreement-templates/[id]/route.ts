import { desc, eq, and } from "drizzle-orm";
import { authed } from "@/server/http";
import { db, schema } from "@/db";
import { uuid } from "@/server/api";
import { notFound } from "@/server/errors";

export const GET = authed<{ id: string }>("templates.view", async ({ auth, params }) => {
  const id = uuid(params.id, "Template");
  const [t] = await db.select().from(schema.agreementTemplates).where(and(eq(schema.agreementTemplates.id, id), eq(schema.agreementTemplates.organisationId, auth.organisationId)));
  if (!t) throw notFound("Template");
  const versions = await db.select({ id: schema.agreementTemplateVersions.id, version: schema.agreementTemplateVersions.version, published: schema.agreementTemplateVersions.published, jurisdiction: schema.agreementTemplateVersions.jurisdiction, language: schema.agreementTemplateVersions.language, publishedAt: schema.agreementTemplateVersions.publishedAt, createdAt: schema.agreementTemplateVersions.createdAt })
    .from(schema.agreementTemplateVersions).where(eq(schema.agreementTemplateVersions.templateId, id)).orderBy(desc(schema.agreementTemplateVersions.version));
  return { template: t, versions };
});
