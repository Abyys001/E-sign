import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";

export const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().optional().transform((v) => v?.split(",").filter(Boolean)),
  sender: z.string().uuid().optional(),
  recipient: z.string().trim().max(200).optional(),
  template: z.string().uuid().optional(),
  type: z.string().max(60).optional(),
  createdFrom: z.coerce.date().optional(), createdTo: z.coerce.date().optional(),
  expiresFrom: z.coerce.date().optional(), expiresTo: z.coerce.date().optional(),
  archived: z.enum(["include", "only", "exclude"]).default("exclude"),
  sort: z.enum(["created", "updated", "expires", "name", "reference", "status"]).default("created"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type ListParams = z.infer<typeof ListQuery> & { page: number; pageSize: number };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function contractFilters(orgId: string, p: Omit<ListParams, "page" | "pageSize" | "sort" | "dir">): SQL {
  const w: (SQL | undefined)[] = [eq(schema.contracts.organisationId, orgId), isNull(schema.contracts.deletedAt)];
  if (p.q) {
    const like = `%${escapeLike(p.q.toLowerCase())}%`;
    w.push(sql`${schema.contracts.searchText} like ${like}`); // trigram GIN index (contracts_search_trgm)
  }
  if (p.status?.length) w.push(inArray(schema.contracts.status, p.status as never));
  if (p.archived === "exclude" && !p.status?.includes("ARCHIVED")) w.push(sql`${schema.contracts.status} <> 'ARCHIVED'`);
  if (p.archived === "only") w.push(eq(schema.contracts.status, "ARCHIVED"));
  if (p.sender) w.push(eq(schema.contracts.createdBy, p.sender));
  if (p.type) w.push(eq(schema.contracts.contractType, p.type));
  if (p.template) w.push(sql`${schema.contracts.templateVersionId} in (select id from template_versions where template_id = ${p.template})`);
  if (p.recipient) w.push(sql`exists (select 1 from recipients r where r.contract_id = ${schema.contracts.id} and r.deleted_at is null and (lower(r.email) like ${`${escapeLike(p.recipient.toLowerCase())}%`} or lower(r.name) like ${`%${escapeLike(p.recipient.toLowerCase())}%`}))`);
  if (p.createdFrom) w.push(gte(schema.contracts.createdAt, p.createdFrom));
  if (p.createdTo) w.push(lte(schema.contracts.createdAt, p.createdTo));
  if (p.expiresFrom) w.push(gte(schema.contracts.expiresAt, p.expiresFrom));
  if (p.expiresTo) w.push(lte(schema.contracts.expiresAt, p.expiresTo));
  return and(...w.filter(Boolean))!;
}

const SORTS = { created: schema.contracts.createdAt, updated: schema.contracts.updatedAt, expires: schema.contracts.expiresAt, name: schema.contracts.name, reference: schema.contracts.reference, status: schema.contracts.status };

export async function listContracts(orgId: string, p: ListParams) {
  const where = contractFilters(orgId, p);
  const col = SORTS[p.sort];
  const order = p.dir === "asc" ? asc(col) : desc(col);
  const [rows, [tot]] = await Promise.all([
    db.select({
      id: schema.contracts.id, reference: schema.contracts.reference, name: schema.contracts.name, status: schema.contracts.status, contractType: schema.contracts.contractType,
      createdAt: schema.contracts.createdAt, updatedAt: schema.contracts.updatedAt, sentAt: schema.contracts.sentAt, expiresAt: schema.contracts.expiresAt, completedAt: schema.contracts.completedAt,
      createdBy: schema.contracts.createdBy, senderName: schema.users.name,
      recipientsTotal: sql<number>`(select count(*)::int from recipients r where r.contract_id = ${schema.contracts.id} and r.deleted_at is null and r.role <> 'CC')`,
      recipientsSigned: sql<number>`(select count(*)::int from recipients r where r.contract_id = ${schema.contracts.id} and r.deleted_at is null and r.role <> 'CC' and r.status = 'COMPLETED')`,
      nextSigner: sql<string | null>`(select r.name from recipients r where r.contract_id = ${schema.contracts.id} and r.deleted_at is null and r.role <> 'CC' and r.status in ('SENT','VIEWED') order by r.signing_order, r.created_at limit 1)`,
    }).from(schema.contracts).innerJoin(schema.users, eq(schema.users.id, schema.contracts.createdBy)).where(where).orderBy(order, desc(schema.contracts.id)).limit(p.pageSize).offset((p.page - 1) * p.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.contracts).where(where),
  ]);
  return { items: rows, page: p.page, pageSize: p.pageSize, total: tot?.n ?? 0 };
}

/** Streaming-friendly export: fetches in keyset pages so a large org never loads everything at once. */
export async function* exportContractRows(orgId: string, p: Omit<ListParams, "page" | "pageSize">) {
  const where = contractFilters(orgId, p);
  let offset = 0;
  for (;;) {
    const rows = await db.select({
      reference: schema.contracts.reference, name: schema.contracts.name, status: schema.contracts.status, type: schema.contracts.contractType, created: schema.contracts.createdAt,
      sent: schema.contracts.sentAt, expires: schema.contracts.expiresAt, completed: schema.contracts.completedAt, sender: schema.users.name,
      recipients: sql<string>`(select string_agg(r.name || ' <' || r.email || '>', '; ' order by r.signing_order) from recipients r where r.contract_id = ${schema.contracts.id} and r.deleted_at is null)`,
    }).from(schema.contracts).innerJoin(schema.users, eq(schema.users.id, schema.contracts.createdBy)).where(where).orderBy(desc(schema.contracts.createdAt), desc(schema.contracts.id)).limit(500).offset(offset);
    if (!rows.length) return;
    yield* rows;
    if (rows.length < 500) return;
    offset += 500;
  }
}
export { ilike };
