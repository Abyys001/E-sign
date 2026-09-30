import { and, asc, desc, eq, gte, ilike, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit, type RequestContext } from "../audit";
import { notFound } from "../errors";
import { describeDevice } from "./device";
import { FormSchema, progress, type Answers } from "./schema";
import { contractStage, invitationState, inviteDedupeKey } from "./invitations";
import { isActive, fmtDuration } from "./telemetry";

/** Without intake.telemetry an IP is shown only as a coarse prefix (/24 for IPv4, /48 for IPv6): enough to spot change, not to locate. */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  const p = ip.split("."); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : null;
}

type Viewer = { telemetry: boolean };
const ip = (v: Viewer, s: string | null) => (v.telemetry ? s : maskIp(s));

export type SecuritySignal = { code: string; message: string; at: string };

/** Signals are prompts for a human, not verdicts: they never claim fraud or identity. */
export function detectSignals(sessions: Array<{ id: string; firstSeenAt: Date; ip: string | null; deviceKey: string | null }>, failedVerifications: number, now = new Date()): SecuritySignal[] {
  const out: SecuritySignal[] = [];
  const sorted = [...sessions].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
  for (let i = 0; i < sorted.length; i++) {
    const win = sorted.filter((s) => s.firstSeenAt >= sorted[i]!.firstSeenAt && s.firstSeenAt.getTime() - sorted[i]!.firstSeenAt.getTime() <= 10 * 60_000);
    const devices = new Set(win.map((s) => s.deviceKey ?? s.id));
    if (devices.size >= 4) { out.push({ code: "many_devices", message: `Unusual access pattern: ${devices.size} new devices in 10 minutes.`, at: sorted[i]!.firstSeenAt.toISOString() }); break; }
  }
  for (let i = 0; i < sorted.length; i++) {
    const win = sorted.filter((s) => s.firstSeenAt >= sorted[i]!.firstSeenAt && s.firstSeenAt.getTime() - sorted[i]!.firstSeenAt.getTime() <= 3_600_000);
    const ips = new Set(win.map((s) => s.ip).filter(Boolean));
    if (ips.size >= 3) { out.push({ code: "ip_changes", message: `Access from ${ips.size} different networks within an hour.`, at: sorted[i]!.firstSeenAt.toISOString() }); break; }
  }
  if (failedVerifications >= 3) out.push({ code: "failed_verification", message: `${failedVerifications} failed verification attempts.`, at: now.toISOString() });
  return out;
}

async function loadInvitation(orgId: string, id: string) {
  const [row] = await db.select({ inv: schema.intakeInvitations, sub: schema.intakeSubmissions, form: schema.intakeForms, ver: schema.intakeFormVersions })
    .from(schema.intakeInvitations)
    .innerJoin(schema.intakeSubmissions, eq(schema.intakeSubmissions.invitationId, schema.intakeInvitations.id))
    .innerJoin(schema.intakeForms, eq(schema.intakeForms.id, schema.intakeInvitations.formId))
    .innerJoin(schema.intakeFormVersions, eq(schema.intakeFormVersions.id, schema.intakeInvitations.formVersionId))
    .where(and(eq(schema.intakeInvitations.id, id), eq(schema.intakeInvitations.organisationId, orgId)));
  if (!row) throw notFound("Invitation");
  return row;
}

export const EVENT_LABEL: Record<string, string> = {
  "intake.opened": "Opened the form", "intake.session_started": "New session started", "intake.session_resumed": "Session resumed", "intake.returned": "Returned to the form",
  "intake.form_started": "Started filling the form", "intake.field_interaction": "Reached a section", "intake.draft_saved": "Saved a draft", "intake.submission_started": "Started submitting",
  "intake.submitted": "Submitted the form", "intake.link_expired": "Opened an expired link", "intake.link_revoked": "Opened a revoked link", "intake.verified": "Verified access", "intake.verification_failed": "Failed verification",
  "email.sent": "Email sent to recipient", "email.delivered": "Email delivered", "email.opened": "Email opened", "email.clicked": "Link clicked in email", "email.bounced": "Email bounced", "email.failed": "Email failed",
  "reminder": "Reminder sent", "contract.generated": "Contract generated", "contract.sent": "Contract sent for signature", "contract.signed": "Signature applied", "contract.completed": "All signatures completed", "invitation.created": "Invitation created",
};

/** Overview + sessions + devices + IPs + unified timeline for one invitation. Answers are never returned here. */
export async function invitationActivity(orgId: string, invitationId: string, viewer: Viewer, now = new Date()) {
  const { inv, sub, form, ver } = await loadInvitation(orgId, invitationId);
  const sessions = await db.select().from(schema.intakeAccessSessions).where(eq(schema.intakeAccessSessions.invitationId, invitationId)).orderBy(asc(schema.intakeAccessSessions.firstSeenAt)).limit(500);
  const events = await db.select().from(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, invitationId)).orderBy(asc(schema.intakeAccessEvents.occurredAt)).limit(1000);
  const [msg] = await db.select().from(schema.emailMessages).where(and(eq(schema.emailMessages.organisationId, orgId), eq(schema.emailMessages.dedupeKey, inviteDedupeKey(invitationId))));
  const mails = await db.select().from(schema.emailMessages).where(and(eq(schema.emailMessages.organisationId, orgId), sql`${schema.emailMessages.payload}->>'intakeInvitationId' = ${invitationId}`));
  const mailEvents = mails.length ? await db.select().from(schema.emailEvents).where(inArray(schema.emailEvents.emailMessageId, mails.map((m) => m.id))) : [];
  const formSchema = FormSchema.parse(ver.schema);
  const prog = progress(formSchema, (sub.answers ?? {}) as Answers);

  const uniq = <T,>(xs: (T | null | undefined)[]) => new Set(xs.filter((x): x is T => x != null));
  const devices = new Map<string, { key: string; firstSeen: Date; lastSeen: Date; browser: string | null; browserVersion: string | null; os: string | null; deviceType: string | null; screenWidth: number | null; screenHeight: number | null; timezone: string | null; ips: Set<string>; sessions: number }>();
  for (const s of sessions) {
    const k = s.deviceKey ?? s.id;
    const d = devices.get(k) ?? { key: k, firstSeen: s.firstSeenAt, lastSeen: s.lastSeenAt, browser: s.browser, browserVersion: s.browserVersion, os: s.os, deviceType: s.deviceType, screenWidth: s.screenWidth, screenHeight: s.screenHeight, timezone: s.timezone, ips: new Set<string>(), sessions: 0 };
    d.firstSeen = d.firstSeen < s.firstSeenAt ? d.firstSeen : s.firstSeenAt; d.lastSeen = d.lastSeen > s.lastSeenAt ? d.lastSeen : s.lastSeenAt; d.sessions++; if (s.ip) d.ips.add(s.ip);
    devices.set(k, d);
  }
  const ips = new Map<string, { ip: string; firstSeen: Date; lastSeen: Date; sessions: Set<string> }>();
  for (const e of events) if (e.ip) { const r = ips.get(e.ip) ?? { ip: e.ip, firstSeen: e.occurredAt, lastSeen: e.occurredAt, sessions: new Set<string>() }; r.lastSeen = e.occurredAt; if (e.sessionId) r.sessions.add(e.sessionId); ips.set(e.ip, r); }
  const last = [...sessions].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
  const activeSessions = sessions.filter((s) => isActive(s.lastSeenAt, now));
  const failed = events.filter((e) => e.type === "intake.verification_failed").length;
  const stage = await contractStage(orgId, sub);
  const state = invitationState(inv, sub, msg?.status ?? null, now);

  const timeline: Array<{ at: Date; type: string; label: string; source: "email" | "form" | "contract" | "system"; detail?: string }> = [];
  timeline.push({ at: inv.createdAt, type: "invitation.created", label: EVENT_LABEL["invitation.created"]!, source: "system" });
  for (const m of mails) if (m.sentAt) timeline.push({ at: m.sentAt, type: m.template === "intake_reminder" ? "reminder" : "email.sent", label: m.template === "intake_reminder" ? EVENT_LABEL.reminder! : EVENT_LABEL["email.sent"]!, source: "email" });
  for (const e of mailEvents) { const t = e.type === "DELIVERED" ? "email.delivered" : e.type === "OPEN" ? "email.opened" : e.type === "CLICK" ? "email.clicked" : e.type === "BOUNCE" ? "email.bounced" : null; if (t) timeline.push({ at: e.occurredAt, type: t, label: EVENT_LABEL[t]!, source: "email" }); }
  for (const e of events) {
    if (["intake.field_interaction"].includes(e.type)) { const m = e.metadata as { section?: string; state?: string }; const title = formSchema.sections.find((s) => s.key === m.section)?.title ?? m.section ?? ""; timeline.push({ at: e.occurredAt, type: e.type, label: `${m.state === "completed" ? "Completed" : "Entered"} section: ${title}`, source: "form" }); continue; }
    if (["intake.session_started", "intake.session_resumed"].includes(e.type)) continue; // collapsed into opened/returned to keep the timeline readable
    timeline.push({ at: e.occurredAt, type: e.type, label: EVENT_LABEL[e.type] ?? e.type, source: "form" });
  }
  if (sub.contractId) {
    const cev = await db.select({ t: schema.auditEvents.eventType, at: schema.auditEvents.occurredAt }).from(schema.auditEvents).where(and(eq(schema.auditEvents.organisationId, orgId), eq(schema.auditEvents.contractId, sub.contractId), inArray(schema.auditEvents.eventType, ["contract.generated_from_intake", "contract.sent", "signature.applied", "contract.status.completed"]))).orderBy(asc(schema.auditEvents.occurredAt));
    for (const e of cev) { const t = e.t === "contract.generated_from_intake" ? "contract.generated" : e.t === "contract.sent" ? "contract.sent" : e.t === "signature.applied" ? "contract.signed" : "contract.completed"; timeline.push({ at: e.at, type: t, label: EVENT_LABEL[t]!, source: "contract" }); }
  }
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

  const activeSeconds = sessions.reduce((n, s) => n + s.activeSeconds, 0);
  return {
    invitation: { id: inv.id, recipientName: inv.recipientName, recipientEmail: inv.recipientEmail, state, contractStage: stage, contractId: sub.contractId, sentAt: inv.sentAt, expiresAt: inv.expiresAt, revokedAt: inv.revokedAt, authMode: inv.authMode, formId: form.id, formTitle: form.title, workflow: ver.workflow, generationStatus: sub.generationStatus, generationError: sub.generationError, submittedAt: sub.submittedAt, emailStatus: msg?.status ?? null },
    overview: {
      totalOpens: inv.openCount, uniqueSessions: sessions.length, uniqueDevices: devices.size, uniqueIps: uniq(sessions.map((s) => s.ip)).size,
      firstOpenedAt: inv.firstOpenedAt, lastOpenedAt: inv.lastOpenedAt, currentlyActive: activeSessions.length > 0, started: !!inv.startedAt, startedAt: inv.startedAt, draftSaved: !!inv.lastSavedAt, lastSavedAt: inv.lastSavedAt, submitted: sub.status === "SUBMITTED",
      approxActiveSeconds: activeSeconds, approxActive: `≈ ${fmtDuration(activeSeconds)} (approximate)`, progress: { percent: prog.percent, sections: prog.sections.map((s) => ({ key: s.key, title: s.title, status: s.status })) },
      lastDevice: last ? describeDevice(last) : null, lastIp: last ? ip(viewer, last.ip) : null,
    },
    sessions: sessions.map((s) => ({ id: s.id, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt, visits: s.pageVisits, active: isActive(s.lastSeenAt, now), activeSeconds: s.activeSeconds, device: describeDevice(s), browser: s.browser, os: s.os, deviceType: s.deviceType, ip: ip(viewer, s.ip), verified: !!s.verifiedAt, sectionProgress: s.sectionProgress })),
    devices: [...devices.values()].map((d) => ({ firstSeen: d.firstSeen, lastSeen: d.lastSeen, browser: d.browser ? `${d.browser}${d.browserVersion ? ` ${d.browserVersion}` : ""}` : null, os: d.os, deviceType: d.deviceType, screen: d.screenWidth && d.screenHeight ? `${d.screenWidth}×${d.screenHeight}` : null, timezone: d.timezone, ipCount: d.ips.size, sessionCount: d.sessions })),
    ips: [...ips.values()].map((r) => ({ ip: ip(viewer, r.ip), firstSeen: r.firstSeen, lastSeen: r.lastSeen, sessions: r.sessions.size, network: null as string | null, status: r.lastSeen.getTime() > now.getTime() - 3_600_000 ? "recent" : "seen" })),
    signals: detectSignals(sessions, failed, now),
    timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
  };
}

export type AccessFilter = { from?: Date; to?: Date; invitationId?: string; browser?: string; os?: string; deviceType?: string; ip?: string; sessionId?: string; type?: string; status?: string; page: number; pageSize: number };

/** Paginated access events for a form (all its invitations). Filtering happens in SQL; never loads the whole history. */
export async function listAccessEvents(orgId: string, formId: string, f: AccessFilter, viewer: Viewer) {
  const [form] = await db.select({ id: schema.intakeForms.id }).from(schema.intakeForms).where(and(eq(schema.intakeForms.id, formId), eq(schema.intakeForms.organisationId, orgId)));
  if (!form) throw notFound("Form");
  const E = schema.intakeAccessEvents, S = schema.intakeAccessSessions;
  const conds: (SQL | undefined)[] = [eq(E.organisationId, orgId), eq(E.formId, formId), f.from ? gte(E.occurredAt, f.from) : undefined, f.to ? lte(E.occurredAt, f.to) : undefined, f.invitationId ? eq(E.invitationId, f.invitationId) : undefined,
    f.type ? eq(E.type, f.type) : undefined, f.ip && viewer.telemetry ? eq(E.ip, f.ip) : undefined, f.sessionId ? eq(E.sessionId, f.sessionId) : undefined,
    f.browser ? ilike(S.browser, `%${f.browser.replace(/[%_]/g, "")}%`) : undefined, f.os ? ilike(S.os, `%${f.os.replace(/[%_]/g, "")}%`) : undefined, f.deviceType ? eq(S.deviceType, f.deviceType) : undefined];
  const where = and(...conds);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(E).leftJoin(S, eq(S.id, E.sessionId)).where(where) as [{ n: number }];
  const rows = await db.select({ e: E, s: { browser: S.browser, browserVersion: S.browserVersion, os: S.os, deviceType: S.deviceType } }).from(E).leftJoin(S, eq(S.id, E.sessionId)).where(where).orderBy(desc(E.occurredAt)).limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { total: n, page: f.page, pageSize: f.pageSize, items: rows.map((r) => ({ id: r.e.id, at: r.e.occurredAt, type: r.e.type, label: EVENT_LABEL[r.e.type] ?? r.e.type, invitationId: r.e.invitationId, sessionId: r.e.sessionId, ip: ip(viewer, r.e.ip), browser: r.s?.browser ? `${r.s.browser}${r.s.browserVersion ? ` ${r.s.browserVersion}` : ""}` : null, os: r.s?.os ?? null, deviceType: r.s?.deviceType ?? null })) };
}

/** Paginated sessions for a form. */
export async function listSessions(orgId: string, formId: string, f: AccessFilter, viewer: Viewer, now = new Date()) {
  const S = schema.intakeAccessSessions;
  const where = and(eq(S.organisationId, orgId), eq(S.formId, formId), f.from ? gte(S.lastSeenAt, f.from) : undefined, f.to ? lte(S.firstSeenAt, f.to) : undefined, f.invitationId ? eq(S.invitationId, f.invitationId) : undefined,
    f.browser ? ilike(S.browser, `%${f.browser.replace(/[%_]/g, "")}%`) : undefined, f.os ? ilike(S.os, `%${f.os.replace(/[%_]/g, "")}%`) : undefined, f.deviceType ? eq(S.deviceType, f.deviceType) : undefined, f.ip && viewer.telemetry ? eq(S.ip, f.ip) : undefined,
    f.status === "active" ? gte(S.lastSeenAt, new Date(now.getTime() - 2 * 60_000)) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(S).where(where) as [{ n: number }];
  const rows = await db.select().from(S).where(where).orderBy(desc(S.lastSeenAt)).limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { total: n, page: f.page, pageSize: f.pageSize, items: rows.map((s) => ({ id: s.id, invitationId: s.invitationId, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt, visits: s.pageVisits, active: isActive(s.lastSeenAt, now), activeSeconds: s.activeSeconds, device: describeDevice(s), ip: ip(viewer, s.ip) })) };
}

/** Devices for a form, grouped by coarse device key, computed in SQL and paginated. */
export async function listDevices(orgId: string, formId: string, f: { page: number; pageSize: number }, viewer: Viewer) {
  const S = schema.intakeAccessSessions;
  const where = and(eq(S.organisationId, orgId), eq(S.formId, formId));
  const grouped = db.select({
    key: sql<string>`coalesce(${S.deviceKey}, ${S.id}::text)`.as("key"), firstSeen: sql<Date>`min(${S.firstSeenAt})`.as("first_seen"), lastSeen: sql<Date>`max(${S.lastSeenAt})`.as("last_seen"),
    browser: sql<string | null>`max(${S.browser})`.as("browser"), browserVersion: sql<string | null>`max(${S.browserVersion})`.as("bv"), os: sql<string | null>`max(${S.os})`.as("os"), deviceType: sql<string | null>`max(${S.deviceType})`.as("dt"),
    w: sql<number | null>`max(${S.screenWidth})`.as("w"), h: sql<number | null>`max(${S.screenHeight})`.as("h"), ips: sql<number>`count(distinct ${S.ip})::int`.as("ips"), sessions: sql<number>`count(*)::int`.as("sessions"),
  }).from(S).where(where).groupBy(sql`coalesce(${S.deviceKey}, ${S.id}::text)`).as("g");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(grouped) as [{ n: number }];
  const rows = await db.select().from(grouped).orderBy(desc(grouped.lastSeen)).limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  void viewer;
  return { total: n, page: f.page, pageSize: f.pageSize, items: rows.map((d) => ({ firstSeen: d.firstSeen, lastSeen: d.lastSeen, browser: d.browser ? `${d.browser}${d.browserVersion ? ` ${d.browserVersion}` : ""}` : null, os: d.os, deviceType: d.deviceType, screen: d.w && d.h ? `${d.w}×${d.h}` : null, ipCount: d.ips, sessionCount: d.sessions })) };
}

/** Form-level access summary across all invitations. */
export async function formAccessSummary(orgId: string, formId: string, viewer: Viewer, now = new Date()) {
  const [form] = await db.select({ id: schema.intakeForms.id }).from(schema.intakeForms).where(and(eq(schema.intakeForms.id, formId), eq(schema.intakeForms.organisationId, orgId)));
  if (!form) throw notFound("Form");
  const S = schema.intakeAccessSessions;
  const [agg] = await db.select({ sessions: sql<number>`count(*)::int`, devices: sql<number>`count(distinct coalesce(${S.deviceKey}, ${S.id}::text))::int`, ips: sql<number>`count(distinct ${S.ip})::int`, first: sql<Date | null>`min(${S.firstSeenAt})`, last: sql<Date | null>`max(${S.lastSeenAt})`, active: sql<number>`count(*) filter (where ${S.lastSeenAt} > ${new Date(now.getTime() - 2 * 60_000)})::int` }).from(S).where(and(eq(S.organisationId, orgId), eq(S.formId, formId)));
  const [inv] = await db.select({ invitations: sql<number>`count(*)::int`, opens: sql<number>`coalesce(sum(${schema.intakeInvitations.openCount}),0)::int`, started: sql<number>`count(${schema.intakeInvitations.startedAt})::int`, saved: sql<number>`count(${schema.intakeInvitations.lastSavedAt})::int` }).from(schema.intakeInvitations).where(and(eq(schema.intakeInvitations.organisationId, orgId), eq(schema.intakeInvitations.formId, formId)));
  const [sub] = await db.select({ submitted: sql<number>`count(*) filter (where ${schema.intakeSubmissions.status} = 'SUBMITTED')::int` }).from(schema.intakeSubmissions).where(and(eq(schema.intakeSubmissions.organisationId, orgId), eq(schema.intakeSubmissions.formId, formId)));
  void viewer;
  return { invitations: inv!.invitations, totalOpens: inv!.opens, uniqueSessions: agg!.sessions, uniqueDevices: agg!.devices, uniqueIps: agg!.ips, firstOpenedAt: agg!.first, lastOpenedAt: agg!.last, currentlyActive: agg!.active > 0, started: inv!.started, draftSaved: inv!.saved, submitted: sub!.submitted };
}

/** Full telemetry for one invitation as data (subject-access / export). Answers are deliberately not included. */
export async function exportTelemetry(orgId: string, invitationId: string) {
  const [inv] = await db.select({ id: schema.intakeInvitations.id }).from(schema.intakeInvitations).where(and(eq(schema.intakeInvitations.id, invitationId), eq(schema.intakeInvitations.organisationId, orgId)));
  if (!inv) throw notFound("Invitation");
  const sessions = await db.select().from(schema.intakeAccessSessions).where(eq(schema.intakeAccessSessions.invitationId, invitationId));
  const events = await db.select().from(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, invitationId)).orderBy(schema.intakeAccessEvents.id);
  return { invitationId, exportedAt: new Date().toISOString(), sessions: sessions.map(({ sessionHash: _h, ...s }) => s), events };
}

/** Erase telemetry (privacy request). The audit chain records that it happened and how many rows went; answers are untouched. */
export async function deleteTelemetry(tx: Tx, a: { orgId: string; userId: string; ctx: RequestContext }, invitationId: string) {
  const [inv] = await tx.select({ id: schema.intakeInvitations.id, formId: schema.intakeInvitations.formId }).from(schema.intakeInvitations).where(and(eq(schema.intakeInvitations.id, invitationId), eq(schema.intakeInvitations.organisationId, a.orgId)));
  if (!inv) throw notFound("Invitation");
  const ev = await tx.delete(schema.intakeAccessEvents).where(eq(schema.intakeAccessEvents.invitationId, invitationId)).returning({ id: schema.intakeAccessEvents.id });
  await tx.delete(schema.intakeOtps).where(eq(schema.intakeOtps.invitationId, invitationId));
  const se = await tx.delete(schema.intakeAccessSessions).where(eq(schema.intakeAccessSessions.invitationId, invitationId)).returning({ id: schema.intakeAccessSessions.id });
  await audit(tx, { organisationId: a.orgId, userId: a.userId, eventType: "intake.telemetry.deleted", ctx: a.ctx, metadata: { invitationId, formId: inv.formId, sessions: se.length, events: ev.length } });
  return { sessions: se.length, events: ev.length };
}
