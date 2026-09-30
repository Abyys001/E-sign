import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { audit, type RequestContext } from "../audit";
import { encrypt, hashOtp, hashToken, newOtp, safeEqual } from "../crypto";
import { AppError } from "../errors";
import { verifyPassword } from "../auth/password";
import { QUEUES, enqueue } from "../jobs";
import { queueEmail } from "../messaging/email";
import { contractStakeholders, notifyUsers } from "../notifications";
import { rateLimit } from "../rate-limit";
import { getOrgBranding } from "../settings";
import { assertClean } from "../scan";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { deviceKey, ipVersion, parseUserAgent, sanitizeClientInfo } from "./device";
import { FormSchema, FormSettings, allFields, progress, pruneHidden, validateAnswers, type Answers } from "./schema";
import { ACTIVE_WINDOW_MS, BEAT_MIN_INTERVAL_MS, MAX_ACTIVE_DELTA_S, VISIT_GAP_MS, recentlyRecorded, recordAccessEvent } from "./telemetry";

const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const INVALID = "This link is not valid.";

type Invitation = typeof schema.intakeInvitations.$inferSelect;
type Session = typeof schema.intakeAccessSessions.$inferSelect;

export const intakeCookieName = (token: string) => `bes_ik_${hashToken(token).slice(0, 10)}`;
export type CookieOut = { name: string; value: string; maxAgeSeconds: number };

/** Guessing/expired/revoked opens count against the caller's IP; the raw token is never logged or stored. */
async function tokenFailure(ctx: RequestContext) {
  await rateLimit("intakeTokenGuess", ctx.ip ?? "unknown");
}

async function loadInvitation(token: string, ctx: RequestContext): Promise<Invitation> {
  await rateLimit("intakeOpen", ctx.ip ?? "unknown");
  if (!TOKEN_RE.test(token)) { await tokenFailure(ctx); throw new AppError("not_found", INVALID); }
  const [inv] = await db.select().from(schema.intakeInvitations).where(eq(schema.intakeInvitations.tokenHash, hashToken(token)));
  if (!inv) { await tokenFailure(ctx); throw new AppError("not_found", INVALID); }
  const gone = inv.status === "REVOKED" ? "link_revoked" : inv.expiresAt < new Date() ? "link_expired" : null;
  if (gone) {
    await tokenFailure(ctx);
    await db.transaction(async (tx) => {
      if (await recentlyRecorded(tx, inv.id, gone === "link_revoked" ? "intake.link_revoked" : "intake.link_expired", new Date(Date.now() - 3_600_000))) return;
      await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, type: gone === "link_revoked" ? "intake.link_revoked" : "intake.link_expired", ip: ctx.ip });
    });
    throw new AppError("gone", gone === "link_revoked" ? "This link has been withdrawn by the sender." : "This link has expired. Ask the sender for a new one.");
  }
  return inv;
}

async function loadVersion(inv: Invitation) {
  const [v] = await db.select().from(schema.intakeFormVersions).where(eq(schema.intakeFormVersions.id, inv.formVersionId));
  const [f] = await db.select({ title: schema.intakeForms.title }).from(schema.intakeForms).where(eq(schema.intakeForms.id, inv.formId));
  return { v: v!, title: f!.title, schema: FormSchema.parse(v!.schema), settings: FormSettings.parse(v!.settings) };
}

async function staff(tx: Tx, inv: Invitation) { return contractStakeholders(tx, inv.organisationId, inv.createdBy!); }

/**
 * Find or create the browser session for this invitation and record meaningful access.
 * An "open" is a new session or a return after >30 min of inactivity; individual requests are never counted.
 */
async function ensureSession(inv: Invitation, token: string, cookie: string | undefined, ctx: RequestContext): Promise<{ session: Session; cookie: CookieOut | null; newVisit: boolean }> {
  const now = new Date();
  const ua = parseUserAgent(ctx.userAgent);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from intake_invitations where id = ${inv.id} for update`);
    const [fresh] = await tx.select().from(schema.intakeInvitations).where(eq(schema.intakeInvitations.id, inv.id));
    let session: Session | undefined;
    if (cookie && /^[A-Za-z0-9_-]{30,64}$/.test(cookie)) {
      [session] = await tx.select().from(schema.intakeAccessSessions).where(and(eq(schema.intakeAccessSessions.sessionHash, hashToken(cookie)), eq(schema.intakeAccessSessions.invitationId, inv.id)));
    }
    const firstEver = fresh!.openCount === 0;
    let newVisit = false;
    let out: CookieOut | null = null;
    const meta = { ...ua };
    if (session) {
      newVisit = now.getTime() - session.lastSeenAt.getTime() > VISIT_GAP_MS;
      if (newVisit) {
        [session] = await tx.update(schema.intakeAccessSessions).set({ lastSeenAt: now, closedAt: null, pageVisits: sql`${schema.intakeAccessSessions.pageVisits} + 1`, ip: ctx.ip ?? null, ipVersion: ipVersion(ctx.ip), userAgent: ctx.userAgent ?? null, updatedAt: now }).where(eq(schema.intakeAccessSessions.id, session.id)).returning();
        await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session!.id, type: "intake.opened", ip: ctx.ip, metadata: meta });
        await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session!.id, type: "intake.session_resumed", ip: ctx.ip });
      }
    } else {
      await rateLimit("intakeSession", inv.id);
      const value = randomBytes(32).toString("base64url");
      [session] = await tx.insert(schema.intakeAccessSessions).values({
        organisationId: inv.organisationId, formId: inv.formId, formVersionId: inv.formVersionId, invitationId: inv.id, sessionHash: hashToken(value),
        ip: ctx.ip ?? null, ipVersion: ipVersion(ctx.ip), userAgent: ctx.userAgent ?? null, browser: ua.browser, browserVersion: ua.browserVersion, os: ua.os, osVersion: ua.osVersion, deviceType: ua.deviceType,
        verifiedAt: inv.authMode === "NONE" ? now : null, deviceKey: deviceKey(ua, sanitizeClientInfo({})),
      }).returning();
      newVisit = true;
      out = { name: intakeCookieName(token), value, maxAgeSeconds: Math.max(60, Math.floor((inv.expiresAt.getTime() - now.getTime()) / 1000)) };
      await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session!.id, type: "intake.opened", ip: ctx.ip, metadata: meta });
      await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session!.id, type: "intake.session_started", ip: ctx.ip });
      await audit(tx, { organisationId: inv.organisationId, eventType: "intake.session.started", ctx, metadata: { invitationId: inv.id, formId: inv.formId, sessionId: session!.id } });
    }
    if (newVisit) {
      await tx.update(schema.intakeInvitations).set({ openCount: sql`${schema.intakeInvitations.openCount} + 1`, lastOpenedAt: now, firstOpenedAt: fresh!.firstOpenedAt ?? now }).where(eq(schema.intakeInvitations.id, inv.id));
      await audit(tx, { organisationId: inv.organisationId, eventType: "intake.link.accessed", ctx, metadata: { invitationId: inv.id, formId: inv.formId, sessionId: session!.id, visit: fresh!.openCount + 1 } });
      const [form] = await tx.select({ title: schema.intakeForms.title }).from(schema.intakeForms).where(eq(schema.intakeForms.id, inv.formId));
      const data = { invitationId: inv.id, formId: inv.formId, formTitle: form!.title, recipient: inv.recipientName };
      if (firstEver) await audit(tx, { organisationId: inv.organisationId, eventType: "intake.form.viewed", ctx, metadata: { invitationId: inv.id, formId: inv.formId } });
      else {
        await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session!.id, type: "intake.returned", ip: ctx.ip });
        await audit(tx, { organisationId: inv.organisationId, eventType: "intake.form.returned", ctx, metadata: { invitationId: inv.id, formId: inv.formId, sessionId: session!.id } });
      }
      await notifyUsers(tx, inv.organisationId, await staff(tx, inv), firstEver ? "intake.opened" : "intake.returned", null, data);
    }
    return { session: session!, cookie: out, newVisit };
  });
}

const publicSchema = (s: FormSchema) => ({
  sections: s.sections.map((sec) => ({
    key: sec.key, title: sec.title, description: sec.description, visibleWhen: sec.visibleWhen,
    fields: sec.fields.map(({ variable: _v, variableMap: _m, preset: _p, ...f }) => f), // internal mapping never leaves the server
  })),
});

async function draftState(inv: Invitation) {
  const [sub] = await db.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id));
  const files = await db.select({ id: schema.intakeFiles.id, key: schema.intakeFiles.fieldKey, name: schema.intakeFiles.filename, size: schema.intakeFiles.sizeBytes }).from(schema.intakeFiles).where(eq(schema.intakeFiles.submissionId, sub!.id));
  return { sub: sub!, files };
}

export type PublicView =
  | { state: "verify"; method: "EMAIL_OTP" | "PASSCODE"; title: string; emailHint: string }
  | { state: "submitted"; title: string; submittedAt: string | null }
  | { state: "form"; title: string; description: string; language: "en" | "fa"; branding: { displayName: string; color: string | null }; schema: ReturnType<typeof publicSchema>; answers: Answers; files: Array<{ id: string; field: string; name: string; size: number }>; rev: number; status: string; progress: ReturnType<typeof progress>; privacyNotice: string | null; expiresAt: string; allowResume: boolean };

export async function openForm(token: string, cookie: string | undefined, ctx: RequestContext): Promise<{ view: PublicView; cookie: CookieOut | null }> {
  const inv = await loadInvitation(token, ctx);
  const { session, cookie: out } = await ensureSession(inv, token, cookie, ctx);
  const meta = await loadVersion(inv);
  const { sub, files } = await draftState(inv);
  if (inv.authMode !== "NONE" && !session.verifiedAt) return { view: { state: "verify", method: inv.authMode as "EMAIL_OTP" | "PASSCODE", title: meta.title, emailHint: inv.recipientEmail.replace(/^(.).*(@.*)$/, "$1•••$2") }, cookie: out };
  if (sub.status === "SUBMITTED") return { view: { state: "submitted", title: meta.title, submittedAt: sub.submittedAt?.toISOString() ?? null }, cookie: out };
  const branding = await getOrgBranding(inv.organisationId);
  const answers = (sub.answers ?? {}) as Answers;
  return {
    view: {
      state: "form", title: meta.title, description: meta.settings.description, language: meta.settings.language,
      branding: { displayName: meta.settings.branding.displayName ?? branding.orgName, color: meta.settings.branding.color ?? branding.primaryColor },
      schema: publicSchema(meta.schema), answers, files: files.map((f) => ({ id: f.id, field: f.key, name: f.name, size: f.size })), rev: sub.rev, status: sub.status,
      progress: progress(meta.schema, answers), privacyNotice: meta.settings.privacyNotice.enabled ? meta.settings.privacyNotice.text : null, expiresAt: inv.expiresAt.toISOString(), allowResume: meta.settings.allowResume,
    },
    cookie: out,
  };
}

/** Resolve the caller's verified session or fail. Used by every mutating public call. */
async function requireSession(inv: Invitation, cookie: string | undefined): Promise<Session> {
  if (!cookie || !/^[A-Za-z0-9_-]{30,64}$/.test(cookie)) throw new AppError("unauthenticated", "Please reopen the link from your email.");
  const [s] = await db.select().from(schema.intakeAccessSessions).where(and(eq(schema.intakeAccessSessions.sessionHash, hashToken(cookie)), eq(schema.intakeAccessSessions.invitationId, inv.id)));
  if (!s) throw new AppError("unauthenticated", "Please reopen the link from your email.");
  if (inv.authMode !== "NONE" && !s.verifiedAt) throw new AppError("forbidden", "Verification is required first.");
  return s;
}

// ------------------------------------------------------------------ verification

export async function requestIntakeOtp(token: string, cookie: string | undefined, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  const session = await requireSessionUnverified(inv, cookie);
  if (inv.authMode !== "EMAIL_OTP") throw new AppError("bad_request", "This form does not use an emailed code.");
  await rateLimit("intakeOtp", inv.id);
  await rateLimit("intakeOtp", `ip:${ctx.ip}`);
  await db.transaction(async (tx) => {
    const [last] = await tx.select().from(schema.intakeOtps).where(eq(schema.intakeOtps.invitationId, inv.id)).orderBy(desc(schema.intakeOtps.createdAt)).limit(1);
    if (last && Date.now() - last.createdAt.getTime() < 45_000) throw new AppError("rate_limited", "A code was just sent. Please wait a moment.", { retryAfterSeconds: 45 }, { "Retry-After": "45" });
    const id = crypto.randomUUID();
    const otp = newOtp();
    await tx.insert(schema.intakeOtps).values({ id, organisationId: inv.organisationId, invitationId: inv.id, sessionId: session.id, codeHash: hashOtp(otp.code, id), expiresAt: new Date(Date.now() + 10 * 60_000) });
    const [form] = await tx.select({ title: schema.intakeForms.title }).from(schema.intakeForms).where(eq(schema.intakeForms.id, inv.formId));
    const brand = await getOrgBranding(inv.organisationId);
    await queueEmail(tx, { orgId: inv.organisationId, template: "otp_code", toEmail: inv.recipientEmail, vars: { recipient_name: inv.recipientName, contract_name: form!.title, organisation_name: brand.orgName, otp_code_enc: encrypt(otp.code) }, dedupeKey: `intake_otp:${id}` });
    await audit(tx, { organisationId: inv.organisationId, eventType: "intake.otp.requested", ctx, metadata: { invitationId: inv.id } });
  });
  return { sentTo: inv.recipientEmail.replace(/^(.).*(@.*)$/, "$1•••$2"), cooldownSeconds: 45 };
}

async function requireSessionUnverified(inv: Invitation, cookie: string | undefined): Promise<Session> {
  if (!cookie || !/^[A-Za-z0-9_-]{30,64}$/.test(cookie)) throw new AppError("unauthenticated", "Please reopen the link from your email.");
  const [s] = await db.select().from(schema.intakeAccessSessions).where(and(eq(schema.intakeAccessSessions.sessionHash, hashToken(cookie)), eq(schema.intakeAccessSessions.invitationId, inv.id)));
  if (!s) throw new AppError("unauthenticated", "Please reopen the link from your email.");
  return s;
}

async function markVerified(inv: Invitation, session: Session, method: string, ctx: RequestContext) {
  await db.transaction(async (tx) => {
    await tx.update(schema.intakeAccessSessions).set({ verifiedAt: new Date() }).where(eq(schema.intakeAccessSessions.id, session.id));
    await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session.id, type: "intake.verified", ip: ctx.ip, metadata: { method } });
    await audit(tx, { organisationId: inv.organisationId, eventType: "intake.verified", ctx, metadata: { invitationId: inv.id, method, sessionId: session.id } });
  });
}

async function failedVerification(inv: Invitation, session: Session, method: string, ctx: RequestContext) {
  await db.transaction(async (tx) => {
    await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: session.id, type: "intake.verification_failed", ip: ctx.ip, metadata: { method } });
    await audit(tx, { organisationId: inv.organisationId, eventType: "intake.verification_failed", ctx, metadata: { invitationId: inv.id, method } });
  });
}

export async function verifyIntakeOtp(token: string, cookie: string | undefined, code: string, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  const session = await requireSessionUnverified(inv, cookie);
  await rateLimit("otpVerifyIp", `intake:${ctx.ip}`);
  const [otp] = await db.select().from(schema.intakeOtps).where(and(eq(schema.intakeOtps.invitationId, inv.id), sql`${schema.intakeOtps.consumedAt} is null`)).orderBy(desc(schema.intakeOtps.createdAt)).limit(1);
  const bad = () => new AppError("forbidden", "That code is not correct or has expired.");
  if (!otp || otp.expiresAt < new Date() || otp.attempts >= otp.maxAttempts) throw bad();
  const ok = /^\d{6}$/.test(code) && safeEqual(hashOtp(code, otp.id), otp.codeHash);
  await db.update(schema.intakeOtps).set(ok ? { consumedAt: new Date(), attempts: sql`${schema.intakeOtps.attempts} + 1` } : { attempts: sql`${schema.intakeOtps.attempts} + 1` }).where(eq(schema.intakeOtps.id, otp.id));
  if (!ok) { await failedVerification(inv, session, "EMAIL_OTP", ctx); throw bad(); }
  await markVerified(inv, session, "EMAIL_OTP", ctx);
  return { verified: true };
}

export async function verifyIntakePasscode(token: string, cookie: string | undefined, passcode: string, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  const session = await requireSessionUnverified(inv, cookie);
  if (inv.authMode !== "PASSCODE") throw new AppError("bad_request", "This form does not use a passcode.");
  await rateLimit("intakeOtp", `pass:${inv.id}`);
  await rateLimit("otpVerifyIp", `intake:${ctx.ip}`);
  if (!(await verifyPassword(inv.passcodeHash, passcode))) { await failedVerification(inv, session, "PASSCODE", ctx); throw new AppError("forbidden", "That passcode is not correct."); }
  await markVerified(inv, session, "PASSCODE", ctx);
  return { verified: true };
}

// ------------------------------------------------------------------ activity (heartbeat)

export type BeatInput = { active?: boolean; client?: unknown; section?: { key: string; state: "entered" | "completed" }; started?: boolean; closing?: boolean };

/**
 * Activity signal. Throttled (<15 s apart is ignored) so scrolling/typing never writes per-event rows; only state changes
 * (device info first seen, section reached, form started) create event rows.
 */
export async function beat(token: string, cookie: string | undefined, input: BeatInput, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  const s = await requireSession(inv, cookie);
  await rateLimit("intakeBeat", s.id);
  const now = new Date();
  const meta = await loadVersion(inv);
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(schema.intakeAccessSessions).where(eq(schema.intakeAccessSessions.id, s.id)).for("update");
    const dt = now.getTime() - cur!.lastSeenAt.getTime();
    const set: Partial<typeof schema.intakeAccessSessions.$inferInsert> = {};
    if (input.client && !cur!.screenWidth) {
      const c = sanitizeClientInfo(input.client);
      Object.assign(set, { screenWidth: c.screenWidth ? Math.round(c.screenWidth) : null, screenHeight: c.screenHeight ? Math.round(c.screenHeight) : null, pixelRatio: c.pixelRatio, language: c.language, timezone: c.timezone, platform: c.platform, deviceKey: deviceKey(parseUserAgent(cur!.userAgent), c) });
    }
    if (dt >= BEAT_MIN_INTERVAL_MS) {
      set.lastSeenAt = now;
      if (input.active && dt <= ACTIVE_WINDOW_MS * 2) set.activeSeconds = cur!.activeSeconds + Math.min(Math.round(dt / 1000), MAX_ACTIVE_DELTA_S);
    }
    if (input.closing) set.closedAt = now;
    if (input.section && meta.schema.sections.some((x) => x.key === input.section!.key)) {
      const prog = { ...((cur!.sectionProgress ?? {}) as Record<string, string>) };
      const prev = prog[input.section.key];
      if (prev !== "completed" && prev !== input.section.state) {
        prog[input.section.key] = input.section.state;
        set.sectionProgress = prog;
        await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: cur!.id, type: "intake.field_interaction", ip: ctx.ip, metadata: { section: input.section.key, state: input.section.state } });
      }
    }
    if (Object.keys(set).length) await tx.update(schema.intakeAccessSessions).set({ ...set, updatedAt: now }).where(eq(schema.intakeAccessSessions.id, cur!.id));
    if (input.started) await markStarted(tx, inv, cur!.id, ctx);
    return { ok: true };
  });
}

async function markStarted(tx: Tx, inv: Invitation, sessionId: string, ctx: RequestContext) {
  const rows = await tx.execute<{ started_at: Date | null }>(sql`select started_at from intake_invitations where id = ${inv.id} for update`);
  if (rows.rows[0]?.started_at) return;
  await tx.update(schema.intakeInvitations).set({ startedAt: new Date() }).where(eq(schema.intakeInvitations.id, inv.id));
  await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId, type: "intake.form_started", ip: ctx.ip });
  await audit(tx, { organisationId: inv.organisationId, eventType: "intake.form.started", ctx, metadata: { invitationId: inv.id, formId: inv.formId, sessionId } });
  const [form] = await tx.select({ title: schema.intakeForms.title }).from(schema.intakeForms).where(eq(schema.intakeForms.id, inv.formId));
  await notifyUsers(tx, inv.organisationId, await staff(tx, inv), "intake.started", null, { invitationId: inv.id, formId: inv.formId, formTitle: form!.title, recipient: inv.recipientName });
}

// ------------------------------------------------------------------ save / submit

export async function saveDraft(token: string, cookie: string | undefined, input: { patch: Answers; explicit?: boolean }, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  const s = await requireSession(inv, cookie);
  await rateLimit("intakeSave", inv.id);
  const meta = await loadVersion(inv);
  if (!meta.settings.allowResume && input.explicit) throw new AppError("forbidden", "Saving for later is disabled for this form.");
  if (JSON.stringify(input.patch).length > 200_000) throw new AppError("payload_too_large", "Too much data in one save.");
  return db.transaction(async (tx) => {
    const [sub] = await tx.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id)).for("update");
    if (sub!.status === "SUBMITTED") throw new AppError("invalid_state", "This form has already been submitted and can no longer be changed.");
    const fields = new Map(allFields(meta.schema).map((f) => [f.key, f]));
    const merged: Answers = { ...((sub!.answers ?? {}) as Answers) };
    const owned = await tx.select({ id: schema.intakeFiles.id, field: schema.intakeFiles.fieldKey }).from(schema.intakeFiles).where(eq(schema.intakeFiles.submissionId, sub!.id));
    for (const [k, v] of Object.entries(input.patch)) {
      const f = fields.get(k);
      if (!f) throw new AppError("validation_failed", `Unknown field "${k}".`);
      if (v === null) { delete merged[k]; continue; }
      if (f.type === "file" || f.type === "files") {
        const refs = f.type === "file" ? [v as { fileId?: string }] : (Array.isArray(v) ? v : []);
        if (!refs.every((r) => owned.some((o) => o.id === r?.fileId && o.field === k))) throw new AppError("validation_failed", `File for "${f.label}" does not belong to this form.`);
      }
      merged[k] = v;
    }
    const check = validateAnswers(meta.schema, merged, { final: false });
    if (check.problems.length) throw new AppError("validation_failed", "Some answers are invalid.", { problems: check.problems });
    const answers = pruneHidden(meta.schema, merged);
    const now = new Date();
    const [row] = await tx.update(schema.intakeSubmissions).set({ answers, rev: sub!.rev + 1, updatedAt: now }).where(eq(schema.intakeSubmissions.id, sub!.id)).returning();
    const firstSave = !inv.lastSavedAt;
    await tx.update(schema.intakeInvitations).set({ lastSavedAt: now }).where(eq(schema.intakeInvitations.id, inv.id));
    await markStarted(tx, inv, s.id, ctx); // no-op when already started
    if (input.explicit || firstSave) {
      await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: s.id, type: "intake.draft_saved", ip: ctx.ip, metadata: { explicit: !!input.explicit } });
      await audit(tx, { organisationId: inv.organisationId, eventType: "intake.form.saved", ctx, metadata: { invitationId: inv.id, formId: inv.formId, sessionId: s.id, explicit: !!input.explicit } });
    }
    return { rev: row!.rev, savedAt: now.toISOString(), progress: progress(meta.schema, answers) };
  });
}

export async function submitForm(token: string, cookie: string | undefined, input: { idempotencyKey?: string }, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  const s = await requireSession(inv, cookie);
  await rateLimit("intakeSubmit", inv.id);
  const meta = await loadVersion(inv);
  return db.transaction(async (tx) => {
    const [sub] = await tx.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id)).for("update");
    if (sub!.status === "SUBMITTED") return { submitted: true, alreadySubmitted: true, submittedAt: sub!.submittedAt!.toISOString() }; // replay/double click: never a second contract
    await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: s.id, type: "intake.submission_started", ip: ctx.ip });
    const answers = (sub!.answers ?? {}) as Answers;
    const check = validateAnswers(meta.schema, answers, { final: true });
    if (!check.ok) throw new AppError("validation_failed", "Please fix the highlighted answers before submitting.", { problems: check.problems, unknownKeys: check.unknownKeys });
    const now = new Date();
    const rev = sub!.submissionRev + 1;
    await tx.update(schema.intakeSubmissions).set({ status: "SUBMITTED", submittedAt: now, lockedAt: now, submissionRev: rev, idempotencyKey: input.idempotencyKey?.slice(0, 120) ?? null, generationStatus: meta.v.workflow === "D" ? "NONE" : "QUEUED", generationError: null, updatedAt: now }).where(eq(schema.intakeSubmissions.id, sub!.id));
    await recordAccessEvent(tx, { orgId: inv.organisationId, formId: inv.formId, invitationId: inv.id, sessionId: s.id, type: "intake.submitted", ip: ctx.ip });
    await audit(tx, { organisationId: inv.organisationId, eventType: "intake.form.submitted", ctx, metadata: { invitationId: inv.id, formId: inv.formId, submissionId: sub!.id, submissionRev: rev, workflow: meta.v.workflow, sessionId: s.id } });
    if (meta.v.workflow !== "D") await enqueue(tx, QUEUES.intakeProcess, { submissionId: sub!.id, submissionRev: rev }, { singletonKey: `${sub!.id}:${rev}` });
    const users = await staff(tx, inv);
    await notifyUsers(tx, inv.organisationId, users, "intake.submitted", null, { invitationId: inv.id, formId: inv.formId, formTitle: meta.title, recipient: inv.recipientName, submissionId: sub!.id });
    const brand = await getOrgBranding(inv.organisationId);
    for (const to of meta.settings.notifyEmails) {
      await queueEmail(tx, { orgId: inv.organisationId, template: "intake_submitted", toEmail: to, locale: "en", dedupeKey: `intake_submitted:${sub!.id}:${rev}:${to}`, vars: { recipient_name: "team", form_title: meta.title, submitted_by: inv.recipientName, organisation_name: brand.orgName, review_url: `${env().APP_URL.replace(/\/$/, "")}/templates/intake/${inv.formId}` } });
    }
    return { submitted: true, alreadySubmitted: false, submittedAt: now.toISOString() };
  });
}

// ------------------------------------------------------------------ uploads

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString() === "%PDF-",
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  docx: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
};
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

export async function uploadFile(token: string, cookie: string | undefined, input: { fieldKey: string; filename: string; bytes: Buffer }, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  await requireSession(inv, cookie);
  await rateLimit("intakeUpload", inv.id);
  const meta = await loadVersion(inv);
  const f = allFields(meta.schema).find((x) => x.key === input.fieldKey && (x.type === "file" || x.type === "files"));
  if (!f) throw new AppError("validation_failed", "This field does not accept files.");
  const max = 15 * 1024 * 1024;
  if (input.bytes.length === 0 || input.bytes.length > max) throw new AppError("payload_too_large", "Files must be between 1 byte and 15 MB.");
  const accept = f.accept ?? ["pdf", "png", "jpg"];
  const kind = accept.find((k) => MAGIC[k]!(input.bytes));
  if (!kind) throw new AppError("unsupported_media", `Accepted file types: ${accept.join(", ")}.`);
  await assertClean(input.bytes);
  const safeName = input.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `file.${kind}`;
  return db.transaction(async (tx) => {
    const [sub] = await tx.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id)).for("update");
    if (sub!.status === "SUBMITTED") throw new AppError("invalid_state", "This form has already been submitted.");
    const existing = await tx.select({ id: schema.intakeFiles.id }).from(schema.intakeFiles).where(and(eq(schema.intakeFiles.submissionId, sub!.id), eq(schema.intakeFiles.fieldKey, f.key)));
    if (existing.length >= (f.type === "file" ? 1 : (f.maxFiles ?? 5))) throw new AppError("validation_failed", "The maximum number of files for this field has been reached. Remove one first.");
    const key = objectKey(inv.organisationId, "intake");
    const put = await storage().put(key, input.bytes, MIME[kind]!);
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: inv.organisationId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: MIME[kind]! }).returning();
    const [row] = await tx.insert(schema.intakeFiles).values({ organisationId: inv.organisationId, submissionId: sub!.id, fieldKey: f.key, storageObjectId: obj!.id, filename: safeName, contentType: MIME[kind]!, sizeBytes: put.sizeBytes }).returning();
    await audit(tx, { organisationId: inv.organisationId, eventType: "intake.file.uploaded", ctx, metadata: { invitationId: inv.id, fileId: row!.id, field: f.key, sha256: put.sha256, bytes: put.sizeBytes } });
    return { fileId: row!.id, filename: safeName, size: put.sizeBytes };
  });
}

export async function removeFile(token: string, cookie: string | undefined, fileId: string, ctx: RequestContext) {
  const inv = await loadInvitation(token, ctx);
  await requireSession(inv, cookie);
  await db.transaction(async (tx) => {
    const [sub] = await tx.select().from(schema.intakeSubmissions).where(eq(schema.intakeSubmissions.invitationId, inv.id)).for("update");
    if (sub!.status === "SUBMITTED") throw new AppError("invalid_state", "This form has already been submitted.");
    const [file] = await tx.select().from(schema.intakeFiles).where(and(eq(schema.intakeFiles.id, fileId), eq(schema.intakeFiles.submissionId, sub!.id)));
    if (!file) throw new AppError("not_found", "File not found.");
    const answers = { ...((sub!.answers ?? {}) as Answers) };
    const v = answers[file.fieldKey];
    if (Array.isArray(v)) answers[file.fieldKey] = v.filter((x) => x?.fileId !== fileId);
    else if ((v as { fileId?: string } | undefined)?.fileId === fileId) delete answers[file.fieldKey];
    await tx.update(schema.intakeSubmissions).set({ answers, rev: sub!.rev + 1, updatedAt: new Date() }).where(eq(schema.intakeSubmissions.id, sub!.id));
    await tx.delete(schema.intakeFiles).where(eq(schema.intakeFiles.id, fileId));
  });
  return { removed: true };
}
