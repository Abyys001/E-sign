/**
 * After editing agreement.md and running gen-global.py: seed the new clause text, publish a new version of the
 * "promoter_global" agreement template pinned to it, and point the company-details intake form at that version.
 *   npx tsx scripts/promoter-agreement/publish-global.ts
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { listClauseVersions, seedClauseLibrary } from "@/server/clauses/service";
import { createDraftFromPublished, pinSelection, publishAgreementVersion, updateAgreementDraft, validateVersionById } from "@/server/agreements/service";
import { agreementType } from "@/server/agreements/types";
import { createFormDraftFromPublished, publishFormVersion, updateIntakeDraft, validateFormVersion } from "@/server/intake/forms";

const FORM_ID = "dce3ddcf-9e66-4f41-aa48-b17cf005daff";
const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.name, "Bilit"));
const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.organisationId, org!.id)).limit(1);
const a = { orgId: org!.id, userId: m!.userId, ctx: { ip: "127.0.0.1", userAgent: "admin-script", correlationId: "publish-global" } } as never;
const [t] = await db.select().from(schema.agreementTemplates).where(and(eq(schema.agreementTemplates.organisationId, org!.id), eq(schema.agreementTemplates.agreementType, "promoter_global")));
const draftId = await db.transaction(async (tx) => {
  console.log("seed", await seedClauseLibrary(tx as never, a));
  const d = await createDraftFromPublished(tx as never, a, t!.id);
  const all = await listClauseVersions(org!.id, { language: "en", status: "PUBLISHED" }, tx as never);
  const { selection, missing } = pinSelection(agreementType("promoter_global")!.clauses, all, d.jurisdiction, d.language);
  if (missing.length) throw new Error(`missing clauses: ${missing.join(", ")}`);
  await updateAgreementDraft(tx as never, a, d.id, { selection });
  return d.id;
});
const v = await validateVersionById(org!.id, draftId);
if (v.errors.length) throw new Error(v.errors.join("; "));
await db.transaction((tx) => publishAgreementVersion(tx as never, a, draftId));
console.log(`global agreement v${v.version.version} published (${(v.version.clauseSelection as unknown[]).length} sections)`);
const fv = await db.transaction(async (tx) => { const d = await createFormDraftFromPublished(tx as never, a, FORM_ID); await updateIntakeDraft(tx as never, a, d.id, { agreementTemplateVersionId: draftId }); return d; });
const fval = await validateFormVersion(org!.id, fv.id);
if (fval.errors.length) throw new Error(fval.errors.join("; "));
await db.transaction((tx) => publishFormVersion(tx as never, a, fv.id));
console.log(`intake form v${fv.version} published -> global agreement v${v.version.version}`);
process.exit(0);
