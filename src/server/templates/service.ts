import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { addContractVersion, validatePdfUpload } from "../documents";
import { getOrgSettings } from "../settings";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { addRecipient, createContract, refreshSearchText, saveFields, type Actor, type RecipientInput } from "../contracts/service";
import { prepareField, type PreparedField } from "../contracts/fields";

export const VariableDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "Use lowercase letters, numbers and underscores"),
  label: z.string().trim().min(1).max(80),
  type: z.enum(["text", "date", "number", "currency"]).default("text"),
  required: z.boolean().default(true),
  default: z.string().max(500).optional(),
});
export type VariableDef = z.infer<typeof VariableDef>;

export const RoleDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["SIGNER", "CC", "WITNESS", "APPROVER"]).default("SIGNER"),
  order: z.number().int().min(1).max(50).default(1),
  required: z.boolean().default(true),
  /** Who normally fills this role (e.g. the Bilit signer). Pre-filled when a contract is created; can be changed per contract. */
  defaultName: z.string().trim().max(200).optional(),
  defaultEmail: z.email().max(254).optional(),
});
export type RoleDef = z.infer<typeof RoleDef>;

export const VARIABLE_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
export const usedVariables = (s: string) => [...s.matchAll(VARIABLE_RE)].map((m) => m[1]!);

/** Every `{{var}}` used anywhere in the template must be declared; declared variables must be unique. */
export function validateTemplateContent(name: string, variables: VariableDef[], fields: unknown[], roles: RoleDef[]) {
  const declared = new Set(variables.map((v) => v.key));
  if (declared.size !== variables.length) throw new AppError("validation_failed", "Variable keys must be unique.");
  if (new Set(roles.map((r) => r.key)).size !== roles.length) throw new AppError("validation_failed", "Recipient role keys must be unique.");
  const texts = [name, ...fields.map((f) => String((f as { defaultValue?: string }).defaultValue ?? "")), ...fields.map((f) => String((f as { label?: string }).label ?? ""))];
  const undeclared = [...new Set(texts.flatMap(usedVariables))].filter((k) => !declared.has(k));
  if (undeclared.length) throw new AppError("validation_failed", `Undeclared variable(s): ${undeclared.map((k) => `{{${k}}}`).join(", ")}. Add them under Variables first.`);
  const roleKeys = new Set(roles.map((r) => r.key));
  for (const f of fields) if (!roleKeys.has(String((f as { recipientId?: string }).recipientId))) throw new AppError("validation_failed", "A field is assigned to a role that does not exist.");
}

export async function createTemplate(tx: Tx, a: Actor, input: { name: string; contractType?: string; pdf?: Buffer }) {
  const [t] = await tx.insert(schema.templates).values({ organisationId: a.orgId, name: input.name.trim(), contractType: input.contractType ?? "general", createdBy: a.userId }).returning();
  const v = await insertVersion(tx, a, t!.id, 1, { pdf: input.pdf });
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "template.created", ctx: a.ctx, metadata: { templateId: t!.id, name: t!.name } });
  return { template: t!, version: v };
}

async function insertVersion(tx: Tx, a: Actor, templateId: string, version: number, src: { pdf?: Buffer; from?: typeof schema.templateVersions.$inferSelect }) {
  let storageObjectId = src.from?.storageObjectId ?? null;
  if (src.pdf) {
    const settings = await getOrgSettings(a.orgId, tx);
    await validatePdfUpload(src.pdf, settings.security.maxUploadMb);
    const key = objectKey(a.orgId, "template");
    const put = await storage().put(key, src.pdf, "application/pdf");
    const [o] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: "application/pdf" }).returning();
    storageObjectId = o!.id;
  }
  const [v] = await tx.insert(schema.templateVersions).values({
    templateId, organisationId: a.orgId, version, storageObjectId, variables: src.from?.variables ?? [], fields: src.from?.fields ?? [], recipientRoles: src.from?.recipientRoles ?? [{ key: "signer_1", name: "Signer 1", role: "SIGNER", order: 1, required: true }], createdBy: a.userId,
  }).returning();
  return v!;
}

async function lockTemplate(tx: Tx, orgId: string, id: string) {
  const r = await tx.execute(sql`select id from templates where id = ${id} and organisation_id = ${orgId} for update`);
  if (!r.rows[0]) throw notFound("Template");
  const [t] = await tx.select().from(schema.templates).where(eq(schema.templates.id, id));
  return t!;
}

/** Published versions are immutable: editing one means creating a new draft version from it. */
export async function createDraftVersion(tx: Tx, a: Actor, templateId: string) {
  const t = await lockTemplate(tx, a.orgId, templateId);
  if (t.status === "ARCHIVED") throw new AppError("invalid_state", "Archived templates cannot be edited. Restore it first.");
  const versions = await tx.select().from(schema.templateVersions).where(eq(schema.templateVersions.templateId, templateId)).orderBy(desc(schema.templateVersions.version));
  if (versions.some((v) => !v.published)) throw new AppError("conflict", "There is already an unpublished draft version. Publish or edit it first.");
  const latest = versions[0]!;
  const v = await insertVersion(tx, a, templateId, latest.version + 1, { from: latest });
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "template.version_created", ctx: a.ctx, metadata: { templateId, version: v.version } });
  return v;
}

export async function updateDraftVersion(tx: Tx, a: Actor, templateId: string, version: number, patch: { name?: string; contractType?: string; variables?: unknown[]; fields?: unknown[]; recipientRoles?: unknown[]; pdf?: Buffer }) {
  const t = await lockTemplate(tx, a.orgId, templateId);
  const [v] = await tx.select().from(schema.templateVersions).where(and(eq(schema.templateVersions.templateId, templateId), eq(schema.templateVersions.version, version), eq(schema.templateVersions.organisationId, a.orgId)));
  if (!v) throw notFound("Template version");
  if (v.published) throw new AppError("invalid_state", "This version is published and cannot be changed. Create a new version instead.");
  const variables = patch.variables ? z.array(VariableDef).max(60).parse(patch.variables) : (v.variables as VariableDef[]);
  const roles = patch.recipientRoles ? z.array(RoleDef).min(1).max(30).parse(patch.recipientRoles) : (v.recipientRoles as RoleDef[]);
  const rawFields = patch.fields ?? (v.fields as unknown[]);
  const name = patch.name ?? t.name;
  validateTemplateContent(name, variables, rawFields, roles);
  let pages: number | null = null;
  let objId = v.storageObjectId;
  if (patch.pdf) {
    const info = await validatePdfUpload(patch.pdf, (await getOrgSettings(a.orgId, tx)).security.maxUploadMb);
    pages = info.info.pageCount;
    const key = objectKey(a.orgId, "template");
    const put = await storage().put(key, patch.pdf, "application/pdf");
    const [o] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: "application/pdf" }).returning();
    objId = o!.id;
  } else if (objId) {
    const [o] = await tx.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, objId));
    const bytes = await storage().getBuffer(o!.key);
    pages = (await validatePdfUpload(bytes, 100)).info.pageCount;
  }
  const prepared: PreparedField[] = [];
  for (const f of rawFields) {
    try { prepared.push(prepareField(f, pages ?? 1e6)); } catch (e) { throw new AppError("validation_failed", e instanceof Error ? e.message : "Invalid field"); }
  }
  const [u] = await tx.update(schema.templateVersions).set({ variables, fields: rawFields, recipientRoles: roles, storageObjectId: objId }).where(eq(schema.templateVersions.id, v.id)).returning();
  await tx.update(schema.templates).set({ name, contractType: patch.contractType ?? t.contractType, updatedAt: new Date() }).where(eq(schema.templates.id, templateId));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "template.edited", ctx: a.ctx, metadata: { templateId, version } });
  return u!;
}

export async function publishVersion(tx: Tx, a: Actor, templateId: string, version: number) {
  const t = await lockTemplate(tx, a.orgId, templateId);
  if (t.status === "ARCHIVED") throw new AppError("invalid_state", "Archived templates cannot be published.");
  const [v] = await tx.select().from(schema.templateVersions).where(and(eq(schema.templateVersions.templateId, templateId), eq(schema.templateVersions.version, version)));
  if (!v) throw notFound("Template version");
  if (v.published) return v;
  if (!v.storageObjectId) throw new AppError("validation_failed", "Upload a PDF before publishing.");
  const roles = v.recipientRoles as RoleDef[];
  const fields = v.fields as Array<{ recipientId: string; type: string }>;
  for (const r of roles.filter((x) => x.role !== "CC")) if (!fields.some((f) => f.recipientId === r.key && ["signature", "initials"].includes(f.type))) throw new AppError("validation_failed", `Role “${r.name}” needs a signature or initials field.`);
  const [u] = await tx.update(schema.templateVersions).set({ published: true }).where(eq(schema.templateVersions.id, v.id)).returning();
  await tx.update(schema.templates).set({ status: "PUBLISHED", updatedAt: new Date() }).where(eq(schema.templates.id, templateId));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "template.published", ctx: a.ctx, metadata: { templateId, version } });
  return u!;
}

export async function setTemplateArchived(tx: Tx, a: Actor, templateId: string, archived: boolean) {
  const t = await lockTemplate(tx, a.orgId, templateId);
  const published = await tx.select({ id: schema.templateVersions.id }).from(schema.templateVersions).where(and(eq(schema.templateVersions.templateId, templateId), eq(schema.templateVersions.published, true))).limit(1);
  const status = archived ? "ARCHIVED" : published.length ? "PUBLISHED" : "DRAFT";
  await tx.update(schema.templates).set({ status, updatedAt: new Date() }).where(eq(schema.templates.id, t.id));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: archived ? "template.archived" : "template.restored", ctx: a.ctx, metadata: { templateId } });
}

export async function deleteTemplate(tx: Tx, a: Actor, templateId: string) {
  await lockTemplate(tx, a.orgId, templateId);
  const used = await tx.select({ id: schema.contracts.id }).from(schema.contracts).innerJoin(schema.templateVersions, eq(schema.templateVersions.id, schema.contracts.templateVersionId)).where(eq(schema.templateVersions.templateId, templateId)).limit(1);
  if (used.length) throw new AppError("invalid_state", "This template has been used by contracts. Archive it instead of deleting it.");
  await tx.delete(schema.templates).where(eq(schema.templates.id, templateId));
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "template.deleted", ctx: a.ctx, metadata: { templateId } });
}

export async function listTemplates(orgId: string, status?: string) {
  return db.execute(sql`
    select t.id, t.name, t.contract_type as "contractType", t.status, t.updated_at as "updatedAt",
      (select max(version) from template_versions v where v.template_id = t.id) as "latestVersion",
      (select max(version) from template_versions v where v.template_id = t.id and v.published) as "publishedVersion",
      (select count(*)::int from contracts c join template_versions v on v.id = c.template_version_id where v.template_id = t.id) as "usage"
    from templates t where t.organisation_id = ${orgId} ${status ? sql`and t.status = ${status}` : sql``} order by t.updated_at desc`).then((r) => r.rows);
}

export async function getTemplate(orgId: string, id: string) {
  const [t] = await db.select().from(schema.templates).where(and(eq(schema.templates.id, id), eq(schema.templates.organisationId, orgId)));
  if (!t) throw notFound("Template");
  const versions = await db.select().from(schema.templateVersions).where(eq(schema.templateVersions.templateId, id)).orderBy(asc(schema.templateVersions.version));
  return { template: t, versions };
}

function fillVars(s: string, vals: Record<string, string>) { return s.replace(VARIABLE_RE, (_m, k: string) => vals[k] ?? ""); }

export type FromTemplateInput = { name?: string; variables?: Record<string, string>; recipients?: Array<Omit<RecipientInput, "role" | "signingOrder" | "required"> & { roleKey: string }>; metadata?: Record<string, unknown>; message?: string | null; expiresAt?: Date | null };

/** Instantiate a published template version: validate variables, copy the PDF, create recipients from role slots and fields with substituted defaults. */
export async function createFromTemplate(tx: Tx, a: Actor, templateVersionId: string, input: FromTemplateInput) {
  const [row] = await tx.select({ v: schema.templateVersions, t: schema.templates }).from(schema.templateVersions).innerJoin(schema.templates, eq(schema.templates.id, schema.templateVersions.templateId))
    .where(and(eq(schema.templateVersions.id, templateVersionId), eq(schema.templateVersions.organisationId, a.orgId)));
  if (!row) throw notFound("Template");
  if (!row.v.published) throw new AppError("invalid_state", "Only published template versions can be used.");
  if (row.t.status === "ARCHIVED") throw new AppError("invalid_state", "This template is archived.");
  const defs = row.v.variables as VariableDef[];
  const roles = row.v.recipientRoles as RoleDef[];
  const vals: Record<string, string> = {};
  const unknown = Object.keys(input.variables ?? {}).filter((k) => !defs.some((d) => d.key === k));
  if (unknown.length) throw new AppError("validation_failed", `Unknown variable(s): ${unknown.join(", ")}`);
  for (const d of defs) {
    const v = (input.variables?.[d.key] ?? d.default ?? "").trim();
    if (!v && d.required) throw new AppError("validation_failed", `${d.label} is required.`, [{ path: d.key, message: "Required" }]);
    if (v && d.type === "number" && !/^-?\d+(\.\d+)?$/.test(v)) throw new AppError("validation_failed", `${d.label} must be a number.`, [{ path: d.key, message: "Not a number" }]);
    if (v && d.type === "currency" && !/^-?\d+(\.\d{1,2})?$/.test(v)) throw new AppError("validation_failed", `${d.label} must be an amount like 1200.50.`, [{ path: d.key, message: "Not an amount" }]);
    if (v && d.type === "date" && Number.isNaN(Date.parse(v))) throw new AppError("validation_failed", `${d.label} must be a date.`, [{ path: d.key, message: "Not a date" }]);
    vals[d.key] = v;
  }
  vals.contract_date ??= new Date().toISOString().slice(0, 10);
  const c = await createContract(tx, a, { name: input.name?.trim() || fillVars(row.t.name, vals), contractType: row.t.contractType, message: input.message ?? null, metadata: { ...(input.metadata ?? {}), templateVariables: vals }, expiresAt: input.expiresAt ?? null, templateVersionId });
  const [obj] = await tx.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, row.v.storageObjectId!));
  const ver = await addContractVersion(tx, { orgId: a.orgId, contractId: c.id, userId: a.userId, bytes: await storage().getBuffer(obj!.key), reason: `From template “${row.t.name}” v${row.v.version}`, ctx: a.ctx });
  await tx.update(schema.contracts).set({ currentVersionId: ver.id }).where(eq(schema.contracts.id, c.id));
  const byRole = new Map<string, string>();
  for (const role of roles) {
    const who = input.recipients?.find((r) => r.roleKey === role.key) ?? (role.defaultName && role.defaultEmail ? { roleKey: role.key, name: role.defaultName, email: role.defaultEmail } : undefined);
    if (!who) { if (role.required && role.role !== "CC") throw new AppError("validation_failed", `Choose who fills the “${role.name}” role.`); continue; }
    const r = await addRecipient(tx, a, c.id, { ...who, role: role.role, signingOrder: role.order, required: role.required });
    byRole.set(role.key, r.id);
  }
  const fields = (row.v.fields as Array<Record<string, unknown>>).filter((f) => byRole.has(String(f.recipientId))).map((f) => ({ ...f, recipientId: byRole.get(String(f.recipientId)), label: typeof f.label === "string" ? fillVars(f.label, vals) : f.label, defaultValue: typeof f.defaultValue === "string" ? fillVars(f.defaultValue, vals) : f.defaultValue }));
  if (fields.length) await saveFields(tx, a, c.id, fields);
  await refreshSearchText(tx, c.id);
  await audit(tx, { organisationId: a.orgId, contractId: c.id, userId: a.userId, eventType: "contract.created_from_template", ctx: a.ctx, metadata: { templateId: row.t.id, version: row.v.version } });
  return c;
}
