import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { AppError, notFound } from "../errors";
import { ConditionSchema, type Condition } from "./condition";
import { findVariables } from "../variables/registry";
import { SEED_CLAUSES } from "./library";
import type { ClauseVersionRow } from "./compose";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
type VersionRow = typeof schema.clauseVersions.$inferSelect;
type ClauseRow = typeof schema.clauses.$inferSelect;

export const toRow = (v: VersionRow, c: ClauseRow): ClauseVersionRow => ({
  id: v.id, clauseKey: c.key, category: c.category, module: c.module, title: c.title, version: v.version, language: v.language,
  jurisdiction: v.jurisdiction, body: v.body, reviewStatus: v.reviewStatus, status: v.status, condition: (v.condition ?? null) as Condition | null,
});

/**
 * Install the default clause library for an organisation. Idempotent: an unchanged clause is left alone; a changed seed body
 * becomes a NEW version (published versions are immutable, contracts already generated keep their pinned version).
 * Seeded text is drafting support: review_status stays "unreviewed" until counsel approves it.
 */
export async function seedClauseLibrary(tx: Tx, a: Actor): Promise<{ clauses: number; versions: number }> {
  let versions = 0;
  for (const s of SEED_CLAUSES) {
    const [existing] = await tx.select().from(schema.clauses).where(and(eq(schema.clauses.organisationId, a.orgId), eq(schema.clauses.key, s.key)));
    const cl = existing ?? (await tx.insert(schema.clauses).values({ organisationId: a.orgId, key: s.key, category: s.category, module: s.module, title: s.title, summary: s.summary }).returning())[0]!;
    for (const v of s.versions) {
      const jur = v.jurisdiction ?? "ANY";
      const [latest] = await tx.select().from(schema.clauseVersions)
        .where(and(eq(schema.clauseVersions.clauseId, cl.id), eq(schema.clauseVersions.language, "en"), eq(schema.clauseVersions.jurisdiction, jur)))
        .orderBy(desc(schema.clauseVersions.version)).limit(1);
      if (latest && latest.body === v.body && JSON.stringify(latest.condition ?? null) === JSON.stringify(v.condition ?? null)) continue;
      await tx.insert(schema.clauseVersions).values({
        clauseId: cl.id, organisationId: a.orgId, version: (latest?.version ?? 0) + 1, language: "en", jurisdiction: jur, status: "PUBLISHED", reviewStatus: "unreviewed",
        body: v.body, variableSchema: findVariables(v.body), condition: v.condition ?? null, authorId: a.userId, publishedAt: new Date(),
      });
      versions++;
    }
  }
  if (versions) await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "clause_library.seeded", ctx: a.ctx, metadata: { versions } });
  return { clauses: SEED_CLAUSES.length, versions };
}

export async function listClauseVersions(orgId: string, opts: { language?: string; status?: string } = {}, dbOrTx: Pick<typeof db, "select"> = db): Promise<ClauseVersionRow[]> {
  const rows = await dbOrTx.select({ v: schema.clauseVersions, c: schema.clauses }).from(schema.clauseVersions)
    .innerJoin(schema.clauses, eq(schema.clauses.id, schema.clauseVersions.clauseId))
    .where(and(eq(schema.clauseVersions.organisationId, orgId), opts.language ? eq(schema.clauseVersions.language, opts.language) : undefined, opts.status ? eq(schema.clauseVersions.status, opts.status) : undefined));
  return rows.map((r) => toRow(r.v, r.c));
}

export async function loadVersionsById(orgId: string, ids: string[], dbOrTx: Pick<typeof db, "select"> = db): Promise<Map<string, ClauseVersionRow>> {
  if (!ids.length) return new Map();
  const rows = await dbOrTx.select({ v: schema.clauseVersions, c: schema.clauses }).from(schema.clauseVersions)
    .innerJoin(schema.clauses, eq(schema.clauses.id, schema.clauseVersions.clauseId))
    .where(and(eq(schema.clauseVersions.organisationId, orgId), inArray(schema.clauseVersions.id, ids)));
  return new Map(rows.map((r) => [r.v.id, toRow(r.v, r.c)]));
}

export type NewClauseVersion = { clauseKey: string; jurisdiction?: string; language?: string; body: string; condition?: Condition | null };

/** Create a DRAFT version (new clause key => new clause; existing key => next version). Drafts are editable until published. */
export async function createClauseDraft(tx: Tx, a: Actor, input: NewClauseVersion & { category?: string; title?: string; module?: string; summary?: string }) {
  if (input.condition) ConditionSchema.parse(input.condition);
  const [existing] = await tx.select().from(schema.clauses).where(and(eq(schema.clauses.organisationId, a.orgId), eq(schema.clauses.key, input.clauseKey)));
  if (!existing && !(input.category && input.title)) throw new AppError("validation_failed", "A new clause needs a category and a title.");
  const cl = existing ?? (await tx.insert(schema.clauses).values({ organisationId: a.orgId, key: input.clauseKey, category: input.category!, module: input.module ?? "core", title: input.title!, summary: input.summary ?? "" }).returning())[0]!;
  const lang = input.language ?? "en", jur = input.jurisdiction ?? "ANY";
  const [latest] = await tx.select({ v: schema.clauseVersions.version }).from(schema.clauseVersions)
    .where(and(eq(schema.clauseVersions.clauseId, cl.id), eq(schema.clauseVersions.language, lang), eq(schema.clauseVersions.jurisdiction, jur))).orderBy(desc(schema.clauseVersions.version)).limit(1);
  const [row] = await tx.insert(schema.clauseVersions).values({
    clauseId: cl.id, organisationId: a.orgId, version: (latest?.v ?? 0) + 1, language: lang, jurisdiction: jur, status: "DRAFT", reviewStatus: "unreviewed",
    body: input.body, variableSchema: findVariables(input.body), condition: input.condition ?? null, authorId: a.userId,
  }).returning();
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "clause.draft_created", ctx: a.ctx, metadata: { clauseKey: cl.key, version: row!.version, jurisdiction: jur, language: lang } });
  return row!;
}

async function lockVersion(tx: Tx, orgId: string, id: string) {
  const [v] = await tx.select().from(schema.clauseVersions).where(and(eq(schema.clauseVersions.id, id), eq(schema.clauseVersions.organisationId, orgId))).for("update");
  if (!v) throw notFound("Clause version");
  return v;
}

export async function updateClauseDraft(tx: Tx, a: Actor, id: string, patch: { body?: string; condition?: Condition | null }) {
  const v = await lockVersion(tx, a.orgId, id);
  if (v.status !== "DRAFT") throw new AppError("invalid_state", "Published clause versions cannot be edited. Create a new version.");
  if (patch.condition) ConditionSchema.parse(patch.condition);
  const body = patch.body ?? v.body;
  const [row] = await tx.update(schema.clauseVersions).set({ body, variableSchema: findVariables(body), condition: patch.condition === undefined ? v.condition : patch.condition }).where(eq(schema.clauseVersions.id, id)).returning();
  return row!;
}

export async function publishClauseVersion(tx: Tx, a: Actor, id: string) {
  const v = await lockVersion(tx, a.orgId, id);
  if (v.status !== "DRAFT") throw new AppError("invalid_state", "Only a draft can be published.");
  const [row] = await tx.update(schema.clauseVersions).set({ status: "PUBLISHED", publishedAt: new Date() }).where(eq(schema.clauseVersions.id, id)).returning();
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "clause.published", ctx: a.ctx, metadata: { clauseVersionId: id, version: v.version } });
  return row!;
}

export async function setClauseReviewStatus(tx: Tx, a: Actor, id: string, reviewStatus: "unreviewed" | "in_review" | "approved") {
  const v = await lockVersion(tx, a.orgId, id);
  const [row] = await tx.update(schema.clauseVersions).set({ reviewStatus }).where(eq(schema.clauseVersions.id, id)).returning();
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "clause.review_status_changed", ctx: a.ctx, metadata: { clauseVersionId: id, from: v.reviewStatus, to: reviewStatus } });
  return row!;
}
