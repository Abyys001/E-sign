import { and, eq, inArray } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "./audit";
import { AppError } from "./errors";
import { hashPassword, passwordProblem } from "./auth/password";
import { SYSTEM_ROLES } from "./rbac";
import { SettingsSchema, BrandingSchema } from "./settings/schema";

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

export async function createOrganisation(tx: Tx, input: { name: string; ownerUserId: string; timezone?: string; locale?: "en" | "fa" }, ctx: RequestContext) {
  const base = slugify(input.name);
  let slug = base;
  for (let i = 2; ; i++) {
    const [hit] = await tx.select({ id: schema.organisations.id }).from(schema.organisations).where(eq(schema.organisations.slug, slug));
    if (!hit) break;
    slug = `${base}-${i}`;
  }
  const settings = SettingsSchema.parse({ general: { timezone: input.timezone ?? "UTC", locale: input.locale ?? "en" } });
  const [org] = await tx.insert(schema.organisations).values({ name: input.name, slug, settings, branding: BrandingSchema.parse({}) }).returning();
  await tx.insert(schema.memberships).values({ organisationId: org!.id, userId: input.ownerUserId, roleKey: "ORG_OWNER" });
  await audit(tx, { organisationId: org!.id, userId: input.ownerUserId, eventType: "organisation.created", ctx, metadata: { name: input.name } });
  return org!;
}

export async function createUser(tx: Tx, input: { email: string; name: string; password: string; locale?: "en" | "fa"; isSuperAdmin?: boolean }) {
  const problem = passwordProblem(input.password);
  if (problem) throw new AppError("validation_failed", problem);
  const email = input.email.trim().toLowerCase();
  const [dupe] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (dupe) throw new AppError("conflict", "A user with that email already exists.");
  const [u] = await tx.insert(schema.users).values({ email, name: input.name.trim(), passwordHash: await hashPassword(input.password), locale: input.locale ?? "en", isSuperAdmin: input.isSuperAdmin ?? false }).returning();
  return u!;
}

export async function listUserOrgs(userId: string, isSuperAdmin: boolean) {
  if (isSuperAdmin) return db.select({ id: schema.organisations.id, name: schema.organisations.name, slug: schema.organisations.slug }).from(schema.organisations).orderBy(schema.organisations.name);
  const rows = await db.select({ id: schema.organisations.id, name: schema.organisations.name, slug: schema.organisations.slug })
    .from(schema.memberships).innerJoin(schema.organisations, eq(schema.organisations.id, schema.memberships.organisationId))
    .where(eq(schema.memberships.userId, userId));
  return rows;
}

export async function assertMember(userId: string, isSuperAdmin: boolean, orgId: string) {
  if (isSuperAdmin) return;
  const [m] = await db.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organisationId, orgId)));
  if (!m) throw new AppError("forbidden", "You are not a member of that organisation.");
}

export const ASSIGNABLE_ROLES = Object.keys(SYSTEM_ROLES).filter((r) => !["SUPER_ADMIN", "SIGNER"].includes(r));

export async function addMember(tx: Tx, orgId: string, actorId: string, input: { email: string; name: string; password: string; roleKey: string }, ctx: RequestContext) {
  if (!ASSIGNABLE_ROLES.includes(input.roleKey)) throw new AppError("validation_failed", "Unknown role.");
  const email = input.email.trim().toLowerCase();
  let [u] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u) u = await createUser(tx, input);
  const [dupe] = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.userId, u.id), eq(schema.memberships.organisationId, orgId)));
  if (dupe) throw new AppError("conflict", "That user is already a member.");
  await tx.insert(schema.memberships).values({ organisationId: orgId, userId: u.id, roleKey: input.roleKey });
  await audit(tx, { organisationId: orgId, userId: actorId, eventType: "user.added", ctx, metadata: { memberId: u.id, roleKey: input.roleKey } });
  return u;
}

export async function updateMember(tx: Tx, orgId: string, actorId: string, memberUserId: string, patch: { roleKey?: string; grants?: string[]; denies?: string[] }, ctx: RequestContext) {
  if (patch.roleKey && !ASSIGNABLE_ROLES.includes(patch.roleKey)) throw new AppError("validation_failed", "Unknown role.");
  const [m] = await tx.select().from(schema.memberships).where(and(eq(schema.memberships.userId, memberUserId), eq(schema.memberships.organisationId, orgId)));
  if (!m) throw new AppError("not_found", "Member not found");
  if (m.roleKey === "ORG_OWNER" && patch.roleKey && patch.roleKey !== "ORG_OWNER") {
    const owners = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.organisationId, orgId), eq(schema.memberships.roleKey, "ORG_OWNER")));
    if (owners.length <= 1) throw new AppError("invalid_state", "An organisation needs at least one owner.");
  }
  await tx.update(schema.memberships).set({ roleKey: patch.roleKey ?? m.roleKey, grants: patch.grants ?? m.grants, denies: patch.denies ?? m.denies }).where(eq(schema.memberships.id, m.id));
  await audit(tx, { organisationId: orgId, userId: actorId, eventType: "user.role_changed", ctx, metadata: { memberId: memberUserId, from: m.roleKey, to: patch.roleKey ?? m.roleKey, grants: patch.grants, denies: patch.denies } });
}

export async function removeMember(tx: Tx, orgId: string, actorId: string, memberUserId: string, ctx: RequestContext) {
  const rows = await tx.select().from(schema.memberships).where(eq(schema.memberships.organisationId, orgId));
  const m = rows.find((r) => r.userId === memberUserId);
  if (!m) throw new AppError("not_found", "Member not found");
  if (m.roleKey === "ORG_OWNER" && rows.filter((r) => r.roleKey === "ORG_OWNER").length <= 1) throw new AppError("invalid_state", "An organisation needs at least one owner.");
  await tx.delete(schema.memberships).where(eq(schema.memberships.id, m.id));
  await tx.delete(schema.sessions).where(and(eq(schema.sessions.userId, memberUserId), eq(schema.sessions.activeOrganisationId, orgId)));
  await audit(tx, { organisationId: orgId, userId: actorId, eventType: "user.removed", ctx, metadata: { memberId: memberUserId } });
}

export async function listMembers(orgId: string) {
  return db.select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, roleKey: schema.memberships.roleKey, grants: schema.memberships.grants, denies: schema.memberships.denies, hasTotp: schema.users.totpSecretEnc })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.organisationId, orgId));
}
export { inArray };

// ---------------------------------------------------------------- invitations / password reset

import { randomBytes } from "node:crypto";
import { encrypt, hashToken } from "./crypto";
import { queueEmail } from "./messaging/email";
import { appUrl } from "./messaging/render";
import { getOrgBranding } from "./settings";
import type { Locale } from "./messaging/templates";

/** Invite by email: the person sets their own password through a single-use link (nobody else ever knows it). */
export async function inviteMember(tx: Tx, orgId: string, actor: { id: string; name: string }, input: { email: string; name: string; roleKey: string; locale?: Locale }, ctx: RequestContext) {
  if (!ASSIGNABLE_ROLES.includes(input.roleKey)) throw new AppError("validation_failed", "Unknown role.");
  const email = input.email.trim().toLowerCase();
  let [u] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
  const fresh = !u;
  if (!u) [u] = await tx.insert(schema.users).values({ email, name: input.name.trim(), passwordHash: await hashPassword(randomBytes(24).toString("base64url")), locale: input.locale ?? "en" }).returning();
  const [dupe] = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.userId, u!.id), eq(schema.memberships.organisationId, orgId)));
  if (dupe) throw new AppError("conflict", "That user is already a member.");
  await tx.insert(schema.memberships).values({ organisationId: orgId, userId: u!.id, roleKey: input.roleKey });
  await audit(tx, { organisationId: orgId, userId: actor.id, eventType: "user.invited", ctx, metadata: { memberId: u!.id, roleKey: input.roleKey } });
  if (fresh) await sendUserToken(tx, orgId, u!, "INVITE", actor.name);
  return { user: u!, invited: fresh };
}

export async function sendUserToken(tx: Tx, orgId: string | null, u: { id: string; email: string; name: string; locale: string }, purpose: "INVITE" | "PASSWORD_RESET", senderName: string) {
  const token = randomBytes(32).toString("base64url");
  await tx.insert(schema.userTokens).values({ userId: u.id, organisationId: orgId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + (purpose === "INVITE" ? 7 * 86400_000 : 3600_000)) });
  const orgName = orgId ? (await getOrgBranding(orgId)).orgName : "Bilit.event E-Sign";
  await queueEmail(tx, { orgId: orgId ?? (await tx.select({ id: schema.memberships.organisationId }).from(schema.memberships).where(eq(schema.memberships.userId, u.id)).limit(1))[0]?.id ?? "", template: purpose === "INVITE" ? "invite" : "password_reset", toEmail: u.email, locale: u.locale as Locale,
    vars: { recipient_name: u.name, sender_name: senderName, organisation_name: orgName, invite_url_enc: encrypt(appUrl(`/accept-invite/${token}`)) }, dedupeKey: `${purpose}:${u.id}:${token.slice(0, 10)}` });
}

export async function acceptUserToken(token: string, password: string, ctx: RequestContext) {
  const problem = passwordProblem(password);
  if (problem) throw new AppError("validation_failed", problem);
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(schema.userTokens).where(eq(schema.userTokens.tokenHash, hashToken(token)));
    if (!t || t.usedAt || t.expiresAt < new Date()) throw new AppError("gone", "This link has expired or was already used. Ask for a new one.");
    // Conditional update: two parallel uses of the same link cannot both win.
    const used = await tx.update(schema.userTokens).set({ usedAt: new Date() }).where(and(eq(schema.userTokens.id, t.id), sql`used_at is null`)).returning({ id: schema.userTokens.id });
    if (!used.length) throw new AppError("gone", "This link has expired or was already used. Ask for a new one.");
    await tx.update(schema.users).set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, t.userId));
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, t.userId));
    const orgId = t.organisationId ?? (await tx.select({ id: schema.memberships.organisationId }).from(schema.memberships).where(eq(schema.memberships.userId, t.userId)).limit(1))[0]?.id;
    if (orgId) await audit(tx, { organisationId: orgId, userId: t.userId, eventType: t.purpose === "INVITE" ? "user.invite_accepted" : "auth.password_reset", ctx });
    return { userId: t.userId };
  });
}
import { sql } from "drizzle-orm";
