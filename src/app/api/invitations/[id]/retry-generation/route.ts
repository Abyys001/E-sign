import { and, eq } from "drizzle-orm";
import { authed } from "@/server/http";
import { db, schema } from "@/db";
import { actorOf, tx, uuid } from "@/server/api";
import { notFound } from "@/server/errors";
import { retryGeneration } from "@/server/intake/process";

export const POST = authed<{ id: string }>("intake.send", async ({ auth, ctx, params }) => {
  const [s] = await db.select({ id: schema.intakeSubmissions.id }).from(schema.intakeSubmissions).where(and(eq(schema.intakeSubmissions.invitationId, uuid(params.id, "Invitation")), eq(schema.intakeSubmissions.organisationId, auth.organisationId)));
  if (!s) throw notFound("Submission");
  await tx((t) => retryGeneration(t, actorOf(auth, ctx), s.id));
  return { ok: true };
});
