import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { sha256 } from "../crypto";
import { AppError } from "../errors";
import { can, PERMISSIONS, type Permission } from "../rbac";
import type { AuthContext } from "./session";

/** Machine credential: acts as its creator inside one organisation with ONLY the permissions stored on the key. */
export async function apiKeyAuth(key: string, perm?: Permission | null): Promise<AuthContext> {
  if (!/^bes_live_[0-9a-f]{10}_[A-Za-z0-9_-]{20,}$/.test(key)) throw new AppError("unauthenticated", "Invalid API key.");
  const [row] = await db.select({ k: schema.apiKeys, u: schema.users }).from(schema.apiKeys).innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.createdBy)).where(and(eq(schema.apiKeys.keyHash, sha256(key)), isNull(schema.apiKeys.revokedAt)));
  if (!row || row.u.deletedAt) throw new AppError("unauthenticated", "Invalid API key.");
  const membership = { roleKey: "API_KEY", grants: row.k.permissions.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p)), denies: [] as string[] };
  if (perm && !can(membership, perm)) throw new AppError("forbidden", "This API key does not have that permission.");
  void db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.k.id)).catch(() => undefined);
  return { sessionId: `apikey:${row.k.id}`, csrfToken: "", user: { id: row.u.id, email: row.u.email, username: row.u.username, name: row.u.name, locale: row.u.locale, isSuperAdmin: false, hasTotp: false }, organisationId: row.k.organisationId, membership, elevated: false };
}
