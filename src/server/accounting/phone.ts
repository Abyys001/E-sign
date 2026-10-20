import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { z } from "zod";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import type { RequestContext } from "../audit";
import { hashPassword, verifyPassword } from "../auth/password";
import type { AuthContext } from "../auth/session";
import { hasActiveTotp, verifyTotp } from "../auth/totp";
import { hmac, newToken } from "../crypto";
import { AppError } from "../errors";
import { rateLimit } from "../rate-limit";
import { can } from "../rbac";
import { acctAudit, getAcctSettings, requireAccounting, type Mode } from "./core";

/**
 * Bilit phone app (/phone): the AI Accountant call as an installable, PIN-locked web app.
 *
 * - Enrol, either on the phone itself (signed in + password / 2FA again) or by scanning a one-time QR code shown to a
 *   signed-in, re-authenticated user in Finance settings (10 minutes, single use). The phone gets a long-lived device token in an httpOnly cookie and the
 *   user picks a 6-digit PIN. Only hashes are stored (HMAC for tokens, argon2id for the PIN).
 * - Unlock: device token + PIN → a short phone session (separate cookie). It only opens the phone call endpoints
 *   (/api/phone/*) — never the rest of the finance app — and locks after PHONE_IDLE_MIN minutes without use.
 * - 5 wrong PINs revoke the device; enrolling again needs a full sign-in. Permissions are re-checked on every request,
 *   so removing someone's finance access also stops their phone.
 */
export const PHONE_DEVICE_COOKIE = "bes_phone";
export const PHONE_SESSION_COOKIE = "bes_phone_s";
const DEVICE_DAYS = 180;
export const PHONE_IDLE_MIN = 15;
const SESSION_MAX_H = 12;
const MAX_PIN_TRIES = 5;

const tokenHash = (t: string) => hmac(env().SESSION_SECRET, `phone:${t}`);
const secure = () => env().APP_URL.startsWith("https://");

/** 6 digits, not all the same and not a straight run (123456 / 654321). */
export function pinProblem(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return "The PIN must be exactly 6 digits.";
  if (/^(\d)\1+$/.test(pin)) return "Choose a PIN that is not one digit repeated.";
  const up = "0123456789012", down = "9876543210987";
  if (up.includes(pin) || down.includes(pin)) return "Choose a PIN that is not a sequence like 123456.";
  return null;
}
const Pin = z.string().trim().superRefine((p, c) => { const e = pinProblem(p); if (e) c.addIssue({ code: "custom", message: e }); });
export const EnrolInput = z.object({ name: z.string().trim().min(1).max(60).default("My phone"), pin: Pin, password: z.string().max(200).optional(), totp: z.string().max(12).optional() });
export const PairInput = z.object({ code: z.string().trim().min(20).max(100), name: z.string().trim().min(1).max(60).default("My phone"), pin: Pin });
const PAIR_MIN = 10;
export const UnlockInput = z.object({ pin: z.string().trim().regex(/^\d{6}$/, "Enter your 6-digit PIN") });

async function jar() { return cookies(); }
function setSessionCookie(j: Awaited<ReturnType<typeof cookies>>, token: string, expires: Date) {
  j.set(PHONE_SESSION_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: "strict", path: "/", expires });
}

/** Signed-in user turns this browser into their phone app. Needs password (or 2FA code) again. */
export async function enrolPhone(auth: AuthContext, ctx: RequestContext, input: z.infer<typeof EnrolInput>) {
  requireAccounting();
  if (!can(auth.membership, "accounting.view")) throw new AppError("forbidden", "You do not have access to finance.");
  await rateLimit("phoneEnrol", auth.user.id);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, auth.user.id));
  const totpOn = hasActiveTotp(u!.totpSecretEnc);
  const ok = totpOn ? verifyTotp(u!.totpSecretEnc, input.totp ?? "") : await verifyPassword(u!.passwordHash, input.password ?? "");
  if (!ok) throw new AppError("unauthenticated", totpOn ? "That 2FA code is not valid." : "Password is incorrect.", [{ path: totpOn ? "totp" : "password", message: totpOn ? "Invalid code" : "Incorrect password" }]);
  return createDevice(auth.organisationId, auth.user.id, ctx, input.name, input.pin, { method: totpOn ? "totp" : "password" });
}

/** QR pairing, step 1 (signed in + re-authenticated): a one-time code and the QR image that opens /phone with it. */
export async function createPairing(auth: AuthContext, ctx: RequestContext) {
  requireAccounting();
  if (!can(auth.membership, "accounting.view")) throw new AppError("forbidden", "You do not have access to finance.");
  await rateLimit("phoneEnrol", auth.user.id);
  const code = newToken().token, expiresAt = new Date(Date.now() + PAIR_MIN * 60_000);
  await db.transaction(async (tx) => {
    // Only the newest code of a user is valid.
    await tx.update(schema.acctPhonePairings).set({ usedAt: new Date() }).where(and(eq(schema.acctPhonePairings.userId, auth.user.id), isNull(schema.acctPhonePairings.usedAt)));
    await tx.insert(schema.acctPhonePairings).values({ organisationId: auth.organisationId, userId: auth.user.id, codeHash: tokenHash(`pair:${code}`), expiresAt });
    await acctAudit(tx, { orgId: auth.organisationId, userId: auth.user.id, ctx, action: "phone.pairing_created", entity: "phone_pairing", entityId: auth.user.id });
  });
  const url = `${env().APP_URL.replace(/\/$/, "")}/phone#pair=${encodeURIComponent(code)}`; // fragment: never sent in Referer or server logs
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { url, svg, expiresAt };
}

/** QR pairing, step 2 (on the phone, no sign-in): the code + a new PIN enrol this phone for the code's owner. */
export async function pairPhone(ctx: RequestContext, input: z.infer<typeof PairInput>) {
  requireAccounting();
  await rateLimit("phonePair", ctx.ip ?? "?");
  const now = new Date();
  // Claim the code atomically so it can be used once only.
  const [p] = await db.update(schema.acctPhonePairings).set({ usedAt: now })
    .where(and(eq(schema.acctPhonePairings.codeHash, tokenHash(`pair:${input.code}`)), isNull(schema.acctPhonePairings.usedAt), gt(schema.acctPhonePairings.expiresAt, now))).returning();
  if (!p) throw new AppError("unauthenticated", "This QR code has expired or was already used. Show a new one in Finance settings.", { code: "pair_invalid" });
  const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, p.userId), eq(schema.memberships.organisationId, p.organisationId)));
  const [u] = await db.select({ isSuperAdmin: schema.users.isSuperAdmin, deletedAt: schema.users.deletedAt }).from(schema.users).where(eq(schema.users.id, p.userId));
  const membership = m ? { roleKey: m.roleKey, grants: m.grants, denies: m.denies, isSuperAdmin: u?.isSuperAdmin } : u?.isSuperAdmin ? { roleKey: "SUPER_ADMIN", grants: [], denies: [], isSuperAdmin: true } : null;
  if (!u || u.deletedAt || !can(membership, "accounting.view")) throw new AppError("forbidden", "This account no longer has access to finance.");
  const r = await createDevice(p.organisationId, p.userId, ctx, input.name, input.pin, { method: "qr" });
  await db.update(schema.acctPhonePairings).set({ deviceId: r.id }).where(eq(schema.acctPhonePairings.id, p.id));
  return r;
}

async function createDevice(orgId: string, userId: string, ctx: RequestContext, name: string, pin: string, how: { method: string }) {
  const j = await jar();
  const old = j.get(PHONE_DEVICE_COOKIE)?.value;
  const device = newToken().token, session = newToken().token;
  const now = new Date(), sessionExpiresAt = new Date(Date.now() + SESSION_MAX_H * 3600_000);
  const pinHash = await hashPassword(pin);
  const row = await db.transaction(async (tx) => {
    if (old) await tx.update(schema.acctPhoneDevices).set({ revokedAt: now, revokedReason: "replaced" }).where(and(eq(schema.acctPhoneDevices.tokenHash, tokenHash(old)), isNull(schema.acctPhoneDevices.revokedAt)));
    const [r] = await tx.insert(schema.acctPhoneDevices).values({ organisationId: orgId, userId, name, tokenHash: tokenHash(device), pinHash, sessionHash: tokenHash(session), sessionExpiresAt, lastSeenAt: now, lastUnlockAt: now }).returning({ id: schema.acctPhoneDevices.id });
    await acctAudit(tx, { orgId, userId, ctx, action: "phone.enrolled", entity: "phone_device", entityId: r!.id, new: { name, ...how } });
    return r!;
  });
  j.set(PHONE_DEVICE_COOKIE, device, { httpOnly: true, secure: secure(), sameSite: "strict", path: "/", expires: new Date(Date.now() + DEVICE_DAYS * 86400_000) });
  setSessionCookie(j, session, sessionExpiresAt);
  return { id: row.id };
}

async function deviceFromCookie() {
  const t = (await jar()).get(PHONE_DEVICE_COOKIE)?.value;
  if (!t) return null;
  const [d] = await db.select().from(schema.acctPhoneDevices).where(eq(schema.acctPhoneDevices.tokenHash, tokenHash(t)));
  return d && !d.revokedAt ? d : null;
}

/** What the phone app should show: set-up, PIN pad, or the call screen. Never errors for a missing device. */
export async function phoneStatus() {
  requireAccounting();
  const d = await deviceFromCookie();
  if (!d) return { enrolled: false as const };
  const [u] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, d.userId));
  const s = (await jar()).get(PHONE_SESSION_COOKIE)?.value;
  const unlocked = !!s && d.sessionHash === tokenHash(s) && !!d.sessionExpiresAt && d.sessionExpiresAt > new Date() && !!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < PHONE_IDLE_MIN * 60_000;
  return { enrolled: true as const, unlocked, deviceName: d.name, userName: u?.name ?? "", triesLeft: MAX_PIN_TRIES - d.failedAttempts, idleMinutes: PHONE_IDLE_MIN };
}

export async function unlockPhone(ctx: RequestContext, input: z.infer<typeof UnlockInput>) {
  requireAccounting();
  const d = await deviceFromCookie();
  if (!d) throw new AppError("unauthenticated", "This phone is not set up. Sign in to Bilit Finance to set it up again.", { code: "phone_not_enrolled" });
  await rateLimit("phoneUnlock", d.id);
  if (!(await verifyPassword(d.pinHash, input.pin))) {
    const tries = d.failedAttempts + 1, revoke = tries >= MAX_PIN_TRIES;
    await db.transaction(async (tx) => {
      await tx.update(schema.acctPhoneDevices).set({ failedAttempts: tries, sessionHash: null, ...(revoke ? { revokedAt: new Date(), revokedReason: "too many wrong PINs" } : {}) }).where(eq(schema.acctPhoneDevices.id, d.id));
      await acctAudit(tx, { orgId: d.organisationId, userId: d.userId, ctx, action: revoke ? "phone.revoked" : "phone.pin_failed", entity: "phone_device", entityId: d.id, new: { tries, reason: revoke ? "too many wrong PINs" : undefined } });
    });
    if (revoke) throw new AppError("unauthenticated", "Too many wrong PINs — this phone has been signed out. Sign in to Bilit Finance to set it up again.", { code: "phone_not_enrolled" });
    throw new AppError("unauthenticated", `Wrong PIN. ${MAX_PIN_TRIES - tries} ${MAX_PIN_TRIES - tries === 1 ? "try" : "tries"} left.`, { code: "wrong_pin", triesLeft: MAX_PIN_TRIES - tries });
  }
  const session = newToken().token, now = new Date(), sessionExpiresAt = new Date(Date.now() + SESSION_MAX_H * 3600_000);
  await db.transaction(async (tx) => {
    await tx.update(schema.acctPhoneDevices).set({ failedAttempts: 0, sessionHash: tokenHash(session), sessionExpiresAt, lastSeenAt: now, lastUnlockAt: now }).where(eq(schema.acctPhoneDevices.id, d.id));
    await acctAudit(tx, { orgId: d.organisationId, userId: d.userId, ctx, action: "phone.unlocked", entity: "phone_device", entityId: d.id });
  });
  setSessionCookie(await jar(), session, sessionExpiresAt);
  return { ok: true };
}

export async function lockPhone() {
  const d = await deviceFromCookie();
  if (d) await db.update(schema.acctPhoneDevices).set({ sessionHash: null }).where(eq(schema.acctPhoneDevices.id, d.id));
  (await jar()).delete(PHONE_SESSION_COOKIE);
  return { ok: true };
}

export type PhoneActor = { orgId: string; userId: string; ctx: RequestContext; mode: Mode };

/** Unlocked phone session → the caller, re-checking their finance permission. Also guards against cross-site posts. */
export async function requirePhone(req: NextRequest, ctx: RequestContext): Promise<PhoneActor> {
  requireAccounting();
  if (req.headers.get("x-bilit-phone") !== "1") throw new AppError("forbidden", "Request blocked.");
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).origin !== new URL(env().APP_URL).origin) throw new AppError("forbidden", "Cross-site request blocked.");
  const d = await deviceFromCookie();
  const s = (await jar()).get(PHONE_SESSION_COOKIE)?.value;
  const locked = new AppError("unauthenticated", "The phone is locked. Enter your PIN.", { code: d ? "phone_locked" : "phone_not_enrolled" });
  if (!d || !s || d.sessionHash !== tokenHash(s) || !d.sessionExpiresAt || d.sessionExpiresAt <= new Date()) throw locked;
  if (!d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() >= PHONE_IDLE_MIN * 60_000) {
    await db.update(schema.acctPhoneDevices).set({ sessionHash: null }).where(eq(schema.acctPhoneDevices.id, d.id));
    throw locked;
  }
  const [row] = await db.select({ u: schema.users, m: schema.memberships }).from(schema.users)
    .leftJoin(schema.memberships, and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.organisationId, d.organisationId)))
    .where(eq(schema.users.id, d.userId));
  const membership = row?.m ? { roleKey: row.m.roleKey, grants: row.m.grants, denies: row.m.denies, isSuperAdmin: row.u.isSuperAdmin } : row?.u.isSuperAdmin ? { roleKey: "SUPER_ADMIN", grants: [], denies: [], isSuperAdmin: true } : null;
  if (!row || row.u.deletedAt || !membership || !can(membership, "accounting.view")) {
    await db.update(schema.acctPhoneDevices).set({ revokedAt: new Date(), revokedReason: "finance access removed", sessionHash: null }).where(eq(schema.acctPhoneDevices.id, d.id));
    throw new AppError("forbidden", "You no longer have access to finance.", { code: "phone_not_enrolled" });
  }
  await db.update(schema.acctPhoneDevices).set({ lastSeenAt: new Date() }).where(eq(schema.acctPhoneDevices.id, d.id));
  return { orgId: d.organisationId, userId: d.userId, ctx, mode: (await getAcctSettings(d.organisationId)).defaultMode };
}

// ---------- management (finance settings) ----------
export async function listPhoneDevices(auth: AuthContext) {
  const admin = can(auth.membership, "accounting.admin");
  const rows = await db.select({ id: schema.acctPhoneDevices.id, name: schema.acctPhoneDevices.name, userId: schema.acctPhoneDevices.userId, userName: schema.users.name, createdAt: schema.acctPhoneDevices.createdAt, lastUnlockAt: schema.acctPhoneDevices.lastUnlockAt, lastSeenAt: schema.acctPhoneDevices.lastSeenAt })
    .from(schema.acctPhoneDevices).innerJoin(schema.users, eq(schema.users.id, schema.acctPhoneDevices.userId))
    .where(and(eq(schema.acctPhoneDevices.organisationId, auth.organisationId), isNull(schema.acctPhoneDevices.revokedAt), ...(admin ? [] : [eq(schema.acctPhoneDevices.userId, auth.user.id)])))
    .orderBy(desc(schema.acctPhoneDevices.createdAt));
  return { devices: rows.map((r) => ({ ...r, mine: r.userId === auth.user.id })) };
}

export async function revokePhoneDevice(auth: AuthContext, ctx: RequestContext, id: string) {
  const [d] = await db.select().from(schema.acctPhoneDevices).where(and(eq(schema.acctPhoneDevices.id, id), eq(schema.acctPhoneDevices.organisationId, auth.organisationId)));
  if (!d || d.revokedAt) throw new AppError("not_found", "Phone not found.");
  if (d.userId !== auth.user.id && !can(auth.membership, "accounting.admin")) throw new AppError("forbidden", "You can only sign out your own phones.");
  await db.transaction(async (tx) => {
    await tx.update(schema.acctPhoneDevices).set({ revokedAt: new Date(), revokedReason: "signed out from settings", sessionHash: null }).where(eq(schema.acctPhoneDevices.id, id));
    await acctAudit(tx, { orgId: auth.organisationId, userId: auth.user.id, ctx, action: "phone.revoked", entity: "phone_device", entityId: id, new: { reason: "signed out from settings", owner: d.userId } });
  });
  return { ok: true };
}
