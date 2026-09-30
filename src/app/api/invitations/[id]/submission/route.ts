import { and, eq } from "drizzle-orm";
import { authed } from "@/server/http";
import { db, schema } from "@/db";
import { uuid } from "@/server/api";
import { notFound } from "@/server/errors";
import { FormSchema } from "@/server/intake/schema";

/** The organiser's answers. Separate from telemetry and gated by intake.view. */
export const GET = authed<{ id: string }>("intake.view", async ({ auth, params }) => {
  const id = uuid(params.id, "Invitation");
  const [row] = await db.select({ sub: schema.intakeSubmissions, ver: schema.intakeFormVersions }).from(schema.intakeSubmissions)
    .innerJoin(schema.intakeFormVersions, eq(schema.intakeFormVersions.id, schema.intakeSubmissions.formVersionId))
    .where(and(eq(schema.intakeSubmissions.invitationId, id), eq(schema.intakeSubmissions.organisationId, auth.organisationId)));
  if (!row) throw notFound("Submission");
  const files = await db.select({ id: schema.intakeFiles.id, field: schema.intakeFiles.fieldKey, name: schema.intakeFiles.filename, size: schema.intakeFiles.sizeBytes }).from(schema.intakeFiles).where(eq(schema.intakeFiles.submissionId, row.sub.id));
  return { submissionId: row.sub.id, status: row.sub.status, submittedAt: row.sub.submittedAt, rev: row.sub.submissionRev, answers: row.sub.answers, schema: FormSchema.parse(row.ver.schema), files, contractId: row.sub.contractId, generationStatus: row.sub.generationStatus, generationError: row.sub.generationError };
});
