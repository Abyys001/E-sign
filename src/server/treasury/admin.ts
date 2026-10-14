import type Stripe from "stripe";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { encrypt } from "../crypto";
import { AppError } from "../errors";
import type { RequestContext } from "../audit";
import { queueEmail } from "../messaging/email";
import { appUrl } from "../messaging/render";
import { storage } from "../storage";
import { Currency, isLive, type Mode } from "../accounting/core";
import { issueStaffToken, revokeStaffSessions } from "./auth";
import { logTreasury } from "./audit";
import { safeStripeError, saveTreasuryStored, treasuryGateway, treasuryStored, type Capabilities } from "./stripe";

/**
 * Administrator operations for the treasury staff portal. Guarded by `treasury.admin` at the route layer. Admins create
 * cards funded by the Treasury financial account, manage staff and their one card assignment, decide limit requests, and
 * review the audit trail. Admins never move Treasury money here and are never shown full card numbers.
 */
type Actor = { orgId: string; userId: string; userName: string; ctx: RequestContext };
const INTERVALS = ["per_authorization", "daily", "weekly", "monthly", "yearly", "all_time"] as const;

// ---------- settings ----------
export async function getTreasurySettings(orgId: string, mode: Mode) {
  const c = (await treasuryStored(orgId))[mode] ?? {};
  return { mode, connected: !!c.keyEnc, keyHint: c.keyHint ?? null, financialAccountId: c.financialAccountId ?? null, capabilities: c.capabilities ?? null, lastTestedAt: c.lastTestedAt ?? null, lastError: c.lastError ?? null };
}

export const TreasurySettingsInput = z.object({
  mode: z.enum(["test", "live"]),
  apiKey: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s/g, "") : v), z.string().regex(/^(rk|sk)_(test|live)_[A-Za-z0-9]{10,}$/, "Paste the key exactly as Stripe shows it").optional().nullable()),
  financialAccountId: z.string().trim().regex(/^fa_[A-Za-z0-9_]+$/).optional().nullable(),
  webhookSecret: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().regex(/^whsec_[A-Za-z0-9]+$/).optional().nullable()),
});

export async function updateTreasurySettings(a: Actor, input: z.infer<typeof TreasurySettingsInput>) {
  const all = await treasuryStored(a.orgId);
  const prev = all[input.mode] ?? {};
  if (input.apiKey === null) { all[input.mode] = {}; await saveTreasuryStored(a.orgId, all); await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "settings.key_removed", outcome: "OK", ip: a.ctx.ip, metadata: { mode: input.mode } }); return getTreasurySettings(a.orgId, input.mode); }
  const next = { ...prev } as typeof prev & { webhookSecretEnc?: string | null };
  if (input.apiKey) {
    const live = input.apiKey.includes("_live_");
    if (live !== (input.mode === "live")) throw new AppError("validation_failed", `That is a ${live ? "live" : "test"} key; you are in ${input.mode} mode.`, [{ path: "apiKey", message: "Wrong mode" }]);
    next.keyEnc = encrypt(input.apiKey); next.keyHint = `${input.apiKey.slice(0, 8)}…${input.apiKey.slice(-4)}`;
  }
  if (!next.keyEnc) throw new AppError("validation_failed", "Add the Treasury key first.", [{ path: "apiKey", message: "Required" }]);
  if (input.webhookSecret !== undefined) next.webhookSecretEnc = input.webhookSecret ? encrypt(input.webhookSecret) : null;
  if (input.financialAccountId !== undefined) next.financialAccountId = input.financialAccountId;
  all[input.mode] = next;
  await saveTreasuryStored(a.orgId, all);
  // test the key and detect capabilities
  try {
    const caps = await (await treasuryGateway(a.orgId, input.mode)).capabilities();
    next.capabilities = caps;
    next.lastError = caps.issuing ? null : `Stripe refused Issuing: ${caps.issuingError ?? "unknown reason"}${caps.treasury ? "" : ` — Treasury: ${caps.treasuryError ?? "unknown reason"}`}`;
    if (!next.financialAccountId && caps.financialAccounts[0]) next.financialAccountId = caps.financialAccounts[0].id;
  } catch (e) { next.capabilities = null; next.lastError = safeStripeError(e); }
  next.lastTestedAt = new Date().toISOString();
  all[input.mode] = next;
  await saveTreasuryStored(a.orgId, all);
  await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "settings.updated", outcome: "OK", ip: a.ctx.ip, metadata: { mode: input.mode, keyHint: next.keyHint } });
  return getTreasurySettings(a.orgId, input.mode);
}

export async function detectCapabilities(orgId: string, mode: Mode): Promise<Capabilities> {
  return (await treasuryGateway(orgId, mode)).capabilities();
}

// ---------- cardholders & cards ----------
export const CardholderInput = z.object({
  mode: z.enum(["test", "live"]), name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(200).optional().nullable(), phoneNumber: z.string().trim().max(40).optional().nullable(),
  type: z.enum(["individual", "company"]).default("individual"),
  billing: z.object({ line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).optional().nullable(), city: z.string().trim().min(1).max(100), state: z.string().trim().max(100).optional().nullable(), postalCode: z.string().trim().min(1).max(20), country: z.string().trim().length(2) }),
});
export async function createCardholder(a: Actor, input: z.infer<typeof CardholderInput>) {
  const gw = await treasuryGateway(a.orgId, input.mode);
  let ch: Stripe.Issuing.Cardholder;
  try { ch = await gw.createCardholder({ name: input.name, email: input.email, phoneNumber: input.phoneNumber, type: input.type, billing: { address: { line1: input.billing.line1, line2: input.billing.line2 ?? undefined, city: input.billing.city, state: input.billing.state ?? undefined, postal_code: input.billing.postalCode, country: input.billing.country.toUpperCase() } } }); }
  catch (e) { throw new AppError("invalid_state", `Stripe could not create the cardholder: ${safeStripeError(e)}`); }
  const [row] = await db.insert(schema.treasuryCardholders).values({ organisationId: a.orgId, livemode: isLive(input.mode), stripeCardholderId: ch.id, name: ch.name, email: ch.email ?? null, phoneNumber: ch.phone_number ?? null, type: ch.type, status: ch.status, createdBy: a.userId })
    .onConflictDoUpdate({ target: [schema.treasuryCardholders.organisationId, schema.treasuryCardholders.stripeCardholderId], set: { name: ch.name, status: ch.status, updatedAt: new Date() } }).returning();
  await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "cardholder.created", resource: "cardholder", resourceId: row!.id, outcome: "OK", ip: a.ctx.ip });
  return row!;
}

export const CardInput = z.object({
  mode: z.enum(["test", "live"]), cardholderId: z.string().uuid(), currency: Currency, type: z.enum(["virtual", "physical"]).default("virtual"), nickname: z.string().trim().max(80).optional().nullable(),
  financialAccountId: z.string().trim().regex(/^fa_[A-Za-z0-9_]+$/).optional().nullable(),
  limits: z.array(z.object({ amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), interval: z.enum(INTERVALS) })).max(6).default([]),
});
/** Create an Issuing card funded by the Treasury financial account, and mirror it locally. */
export async function createCard(a: Actor, input: z.infer<typeof CardInput>) {
  const [ch] = await db.select().from(schema.treasuryCardholders).where(and(eq(schema.treasuryCardholders.id, input.cardholderId), eq(schema.treasuryCardholders.organisationId, a.orgId)));
  if (!ch) throw new AppError("not_found", "Cardholder not found");
  const gw = await treasuryGateway(a.orgId, input.mode);
  const spending = input.limits.length ? { spending_limits: input.limits.map((l) => ({ amount: l.amount, interval: l.interval })) } : undefined;
  let card: Stripe.Issuing.Card;
  try { card = await gw.createCard({ cardholder: ch.stripeCardholderId, currency: input.currency, financialAccount: input.financialAccountId, type: input.type, spendingControls: spending }, `tcard-${a.orgId}-${crypto.randomUUID()}`); }
  catch (e) { throw new AppError("invalid_state", `Stripe could not create the card: ${safeStripeError(e)}`); }
  const [row] = await db.insert(schema.treasuryCards).values({
    organisationId: a.orgId, livemode: isLive(input.mode), stripeCardId: card.id, cardholderId: ch.id,
    financialAccountId: (card as unknown as { financial_account?: string | null }).financial_account ?? input.financialAccountId ?? null,
    brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, currency: card.currency, type: card.type, status: card.status,
    spendingControls: (card.spending_controls ?? {}) as unknown as Record<string, unknown>, nickname: input.nickname ?? null, createdBy: a.userId,
  }).returning();
  await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "card.created", resource: "card", resourceId: row!.id, outcome: "OK", ip: a.ctx.ip, metadata: { last4: card.last4 } });
  return row!;
}

/** Pull cardholders and cards from Stripe into the local mirror (so admins can assign cards created directly in Stripe too). */
export async function syncFromStripe(a: Actor, mode: Mode) {
  const gw = await treasuryGateway(a.orgId, mode);
  let holders: Stripe.Issuing.Cardholder[], cards: Stripe.Issuing.Card[];
  try { [holders, cards] = await Promise.all([gw.listCardholders(), gw.listCards()]); }
  catch (e) { throw new AppError("invalid_state", safeStripeError(e)); }
  const live = isLive(mode);
  const idByStripe = new Map<string, string>();
  for (const ch of holders) {
    const [row] = await db.insert(schema.treasuryCardholders).values({ organisationId: a.orgId, livemode: live, stripeCardholderId: ch.id, name: ch.name, email: ch.email ?? null, phoneNumber: ch.phone_number ?? null, type: ch.type, status: ch.status })
      .onConflictDoUpdate({ target: [schema.treasuryCardholders.organisationId, schema.treasuryCardholders.stripeCardholderId], set: { name: ch.name, email: ch.email ?? null, status: ch.status, updatedAt: new Date() } }).returning({ id: schema.treasuryCardholders.id });
    idByStripe.set(ch.id, row!.id);
  }
  let cardsUpserted = 0;
  for (const card of cards) {
    const holderStripeId = typeof card.cardholder === "string" ? card.cardholder : card.cardholder.id;
    let localHolder = idByStripe.get(holderStripeId);
    if (!localHolder) { const [h] = await db.select({ id: schema.treasuryCardholders.id }).from(schema.treasuryCardholders).where(and(eq(schema.treasuryCardholders.organisationId, a.orgId), eq(schema.treasuryCardholders.stripeCardholderId, holderStripeId))); localHolder = h?.id; }
    if (!localHolder) continue;
    await db.insert(schema.treasuryCards).values({
      organisationId: a.orgId, livemode: live, stripeCardId: card.id, cardholderId: localHolder,
      financialAccountId: (card as unknown as { financial_account?: string | null }).financial_account ?? null,
      brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, currency: card.currency, type: card.type, status: card.status, spendingControls: (card.spending_controls ?? {}) as unknown as Record<string, unknown>,
    }).onConflictDoUpdate({ target: [schema.treasuryCards.organisationId, schema.treasuryCards.stripeCardId], set: { status: card.status, spendingControls: (card.spending_controls ?? {}) as unknown as Record<string, unknown>, last4: card.last4, updatedAt: new Date() } });
    cardsUpserted++;
  }
  await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "cards.synced", outcome: "OK", ip: a.ctx.ip, metadata: { cardholders: holders.length, cards: cardsUpserted } });
  return { cardholders: holders.length, cards: cardsUpserted };
}

export async function listCardsAdmin(orgId: string, mode: Mode) {
  const rows = await db.select({ c: schema.treasuryCards, holder: schema.treasuryCardholders.name, staffId: schema.treasuryStaff.id, staffName: schema.treasuryStaff.name })
    .from(schema.treasuryCards)
    .innerJoin(schema.treasuryCardholders, eq(schema.treasuryCardholders.id, schema.treasuryCards.cardholderId))
    .leftJoin(schema.treasuryAssignments, and(eq(schema.treasuryAssignments.cardId, schema.treasuryCards.id), isNull(schema.treasuryAssignments.revokedAt)))
    .leftJoin(schema.treasuryStaff, eq(schema.treasuryStaff.id, schema.treasuryAssignments.staffId))
    .where(and(eq(schema.treasuryCards.organisationId, orgId), eq(schema.treasuryCards.livemode, isLive(mode))))
    .orderBy(desc(schema.treasuryCards.createdAt));
  return rows.map((r) => ({ id: r.c.id, brand: r.c.brand, last4: r.c.last4, currency: r.c.currency, type: r.c.type, status: r.c.status, nickname: r.c.nickname, cardholderName: r.holder, financialAccountId: r.c.financialAccountId, assignedStaffId: r.staffId, assignedStaffName: r.staffName, spendingLimits: ((r.c.spendingControls as { spending_limits?: Array<{ amount: number; interval: string }> } | null)?.spending_limits ?? []) }));
}
export async function listCardholdersAdmin(orgId: string, mode: Mode) {
  return db.select({ id: schema.treasuryCardholders.id, name: schema.treasuryCardholders.name, email: schema.treasuryCardholders.email, status: schema.treasuryCardholders.status })
    .from(schema.treasuryCardholders).where(and(eq(schema.treasuryCardholders.organisationId, orgId), eq(schema.treasuryCardholders.livemode, isLive(mode)))).orderBy(schema.treasuryCardholders.name);
}

// ---------- staff ----------
export const StaffInput = z.object({ email: z.string().trim().email().max(200), name: z.string().trim().min(1).max(200), canFreezeCard: z.boolean().default(false) });
export async function createStaff(a: Actor, input: z.infer<typeof StaffInput>) {
  return db.transaction(async (tx) => {
    const email = input.email.trim().toLowerCase();
    const [existing] = await tx.select({ id: schema.treasuryStaff.id }).from(schema.treasuryStaff).where(sql`lower(${schema.treasuryStaff.email}) = ${email}`); // unique across organisations: the staff login is by email alone
    if (existing) throw new AppError("conflict", "A staff member with that email already exists.", [{ path: "email", message: "Already exists" }]);
    const [s] = await tx.insert(schema.treasuryStaff).values({ organisationId: a.orgId, email, name: input.name, status: "INVITED", canFreezeCard: input.canFreezeCard, createdBy: a.userId }).returning();
    const link = await sendStaffInvite(tx, a, s!, "INVITE");
    await logTreasury(tx, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "staff.created", resource: "staff", resourceId: s!.id, outcome: "OK", ip: a.ctx.ip });
    return { id: s!.id, inviteUrl: link };
  });
}

async function sendStaffInvite(tx: Tx, a: Actor, s: typeof schema.treasuryStaff.$inferSelect, purpose: "INVITE" | "RESET") {
  const token = await issueStaffToken(tx, s.id, purpose);
  const url = appUrl(`/staff/treasury/accept-invite/${token}`);
  await queueEmail(tx, { orgId: a.orgId, template: purpose === "INVITE" ? "invite" : "password_reset", toEmail: s.email, vars: { recipient_name: s.name, sender_name: a.userName, organisation_name: "Bilit Finance", invite_url_enc: encrypt(url) }, dedupeKey: `tstaff:${purpose}:${s.id}:${token.slice(0, 10)}` }).catch(() => null);
  return url; // returned so the admin can copy it even if email delivery is not configured
}

export async function resendInvite(a: Actor, staffId: string) {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(schema.treasuryStaff).where(and(eq(schema.treasuryStaff.id, staffId), eq(schema.treasuryStaff.organisationId, a.orgId))).for("update");
    if (!s) throw new AppError("not_found", "Staff not found");
    if (s.status === "REVOKED") throw new AppError("invalid_state", "This account has been revoked.");
    const link = await sendStaffInvite(tx, a, s, s.passwordHash ? "RESET" : "INVITE");
    await logTreasury(tx, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "staff.invite_resent", resource: "staff", resourceId: s.id, outcome: "OK", ip: a.ctx.ip });
    return { inviteUrl: link };
  });
}

export async function setStaffStatus(a: Actor, staffId: string, status: "ACTIVE" | "SUSPENDED" | "REVOKED") {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(schema.treasuryStaff).where(and(eq(schema.treasuryStaff.id, staffId), eq(schema.treasuryStaff.organisationId, a.orgId))).for("update");
    if (!s) throw new AppError("not_found", "Staff not found");
    if (s.status === "REVOKED") throw new AppError("invalid_state", "This account has been revoked permanently. Create a new staff account instead.");
    if (status === "ACTIVE" && !s.passwordHash) throw new AppError("invalid_state", "This person has not accepted the invitation yet.");
    const set: Partial<typeof schema.treasuryStaff.$inferInsert> = { status, updatedAt: new Date() };
    if (status === "SUSPENDED" || status === "REVOKED") { set.suspendedBy = a.userId; set.suspendedAt = new Date(); await revokeStaffSessions(tx, s.id); }
    if (status === "REVOKED") await tx.update(schema.treasuryAssignments).set({ revokedBy: a.userId, revokedAt: new Date() }).where(and(eq(schema.treasuryAssignments.staffId, s.id), isNull(schema.treasuryAssignments.revokedAt)));
    await tx.update(schema.treasuryStaff).set(set).where(eq(schema.treasuryStaff.id, s.id));
    await logTreasury(tx, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: `staff.${status.toLowerCase()}`, resource: "staff", resourceId: s.id, outcome: "OK", ip: a.ctx.ip });
    return { status };
  });
}

export async function setStaffFreezePolicy(a: Actor, staffId: string, canFreeze: boolean) {
  const [s] = await db.update(schema.treasuryStaff).set({ canFreezeCard: canFreeze, updatedAt: new Date() }).where(and(eq(schema.treasuryStaff.id, staffId), eq(schema.treasuryStaff.organisationId, a.orgId))).returning();
  if (!s) throw new AppError("not_found", "Staff not found");
  await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "staff.freeze_policy", resource: "staff", resourceId: s.id, outcome: "OK", ip: a.ctx.ip, metadata: { canFreeze } });
  return { canFreezeCard: canFreeze };
}

export async function listStaff(orgId: string) {
  const rows = await db.select({ s: schema.treasuryStaff, cardId: schema.treasuryCards.id, last4: schema.treasuryCards.last4, cardStatus: schema.treasuryCards.status })
    .from(schema.treasuryStaff)
    .leftJoin(schema.treasuryAssignments, and(eq(schema.treasuryAssignments.staffId, schema.treasuryStaff.id), isNull(schema.treasuryAssignments.revokedAt)))
    .leftJoin(schema.treasuryCards, eq(schema.treasuryCards.id, schema.treasuryAssignments.cardId))
    .where(eq(schema.treasuryStaff.organisationId, orgId)).orderBy(schema.treasuryStaff.name);
  return rows.map((r) => ({ id: r.s.id, name: r.s.name, email: r.s.email, status: r.s.status, canFreezeCard: r.s.canFreezeCard, lastLoginAt: r.s.lastLoginAt, assignedCardId: r.cardId, assignedLast4: r.last4, assignedCardStatus: r.cardStatus }));
}

// ---------- assignment ----------
export async function assignCard(a: Actor, staffId: string, cardId: string) {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(schema.treasuryStaff).where(and(eq(schema.treasuryStaff.id, staffId), eq(schema.treasuryStaff.organisationId, a.orgId)));
    if (!s || s.status === "REVOKED") throw new AppError("invalid_state", "This staff account is not available for assignment.");
    const [card] = await tx.select().from(schema.treasuryCards).where(and(eq(schema.treasuryCards.id, cardId), eq(schema.treasuryCards.organisationId, a.orgId))).for("update");
    if (!card) throw new AppError("not_found", "Card not found");
    if (card.status === "canceled") throw new AppError("invalid_state", "A cancelled card cannot be assigned.");
    const [held] = await tx.select({ id: schema.treasuryAssignments.id }).from(schema.treasuryAssignments).where(and(eq(schema.treasuryAssignments.cardId, cardId), isNull(schema.treasuryAssignments.revokedAt)));
    if (held) throw new AppError("conflict", "That card is already assigned to someone. Revoke the current assignment first.");
    const [row] = await tx.insert(schema.treasuryAssignments).values({ organisationId: a.orgId, staffId, cardId, assignedBy: a.userId }).returning();
    await logTreasury(tx, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "card.assigned", resource: "assignment", resourceId: row!.id, outcome: "OK", ip: a.ctx.ip, metadata: { staffId, cardId } });
    return { id: row!.id };
  });
}

export async function revokeAssignment(a: Actor, cardId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.treasuryAssignments).set({ revokedBy: a.userId, revokedAt: new Date() })
      .where(and(eq(schema.treasuryAssignments.cardId, cardId), eq(schema.treasuryAssignments.organisationId, a.orgId), isNull(schema.treasuryAssignments.revokedAt))).returning();
    if (!row) throw new AppError("not_found", "No active assignment for that card.");
    await logTreasury(tx, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "card.unassigned", resource: "assignment", resourceId: row.id, outcome: "OK", ip: a.ctx.ip, metadata: { cardId } });
    return { ok: true };
  });
}

// ---------- limit requests ----------
export async function listLimitRequests(orgId: string, status?: "PENDING" | "APPROVED" | "REJECTED") {
  const rows = await db.select({ r: schema.treasuryLimitRequests, staffName: schema.treasuryStaff.name, last4: schema.treasuryCards.last4 })
    .from(schema.treasuryLimitRequests)
    .innerJoin(schema.treasuryStaff, eq(schema.treasuryStaff.id, schema.treasuryLimitRequests.staffId))
    .innerJoin(schema.treasuryCards, eq(schema.treasuryCards.id, schema.treasuryLimitRequests.cardId))
    .where(and(eq(schema.treasuryLimitRequests.organisationId, orgId), status ? eq(schema.treasuryLimitRequests.status, status) : undefined))
    .orderBy(desc(schema.treasuryLimitRequests.createdAt)).limit(200);
  return rows.map((r) => ({ id: r.r.id, staffName: r.staffName, last4: r.last4, interval: r.r.interval, currentAmount: r.r.currentAmount, requestedAmount: r.r.requestedAmount, currency: r.r.currency, reason: r.r.reason, status: r.r.status, createdAt: r.r.createdAt, decisionNote: r.r.decisionNote }));
}

export const DecisionInput = z.object({ approve: z.boolean(), note: z.string().trim().max(1000).optional().nullable() });
/** Approve (apply the new limit to the card in Stripe) or reject a limit request. */
export async function decideLimitRequest(a: Actor, requestId: string, input: z.infer<typeof DecisionInput>) {
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(schema.treasuryLimitRequests).where(and(eq(schema.treasuryLimitRequests.id, requestId), eq(schema.treasuryLimitRequests.organisationId, a.orgId))).for("update");
    if (!req) throw new AppError("not_found", "Request not found");
    if (req.status !== "PENDING") throw new AppError("invalid_state", "This request has already been decided.");
    const [card] = await tx.select().from(schema.treasuryCards).where(eq(schema.treasuryCards.id, req.cardId));
    if (input.approve && card) {
      const existing = ((card.spendingControls as { spending_limits?: Array<{ amount: number; interval: string }> } | null)?.spending_limits ?? []).filter((l) => l.interval !== req.interval);
      const next = [...existing, { amount: req.requestedAmount, interval: req.interval }];
      const gw = await treasuryGateway(a.orgId, card.livemode ? "live" : "test");
      let updated: Stripe.Issuing.Card;
      try { updated = await gw.setSpendingControls(card.stripeCardId, { spending_limits: next as Stripe.Issuing.CardUpdateParams.SpendingControls.SpendingLimit[] }); }
      catch (e) { throw new AppError("invalid_state", `Stripe could not apply the new limit: ${safeStripeError(e)}`); }
      await tx.update(schema.treasuryCards).set({ spendingControls: (updated.spending_controls ?? {}) as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(schema.treasuryCards.id, card.id));
    }
    await tx.update(schema.treasuryLimitRequests).set({ status: input.approve ? "APPROVED" : "REJECTED", decidedBy: a.userId, decidedAt: new Date(), decisionNote: input.note ?? null }).where(eq(schema.treasuryLimitRequests.id, requestId));
    await logTreasury(tx, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: input.approve ? "limit.approved" : "limit.rejected", resource: "limit_request", resourceId: requestId, outcome: "OK", ip: a.ctx.ip });
    return { status: input.approve ? "APPROVED" : "REJECTED" };
  });
}

// ---------- oversight: card activity, expenses, export ----------
type Holding = { staffId: string; staffName: string; from: number; to: number };
/** Who held a card when: every assignment (active and revoked) of the card, oldest first, as unix-second ranges. */
async function holdings(cardId: string): Promise<Holding[]> {
  const rows = await db.select({ a: schema.treasuryAssignments, name: schema.treasuryStaff.name }).from(schema.treasuryAssignments)
    .innerJoin(schema.treasuryStaff, eq(schema.treasuryStaff.id, schema.treasuryAssignments.staffId))
    .where(eq(schema.treasuryAssignments.cardId, cardId)).orderBy(schema.treasuryAssignments.assignedAt);
  return rows.map((r) => ({ staffId: r.a.staffId, staffName: r.name, from: Math.floor(r.a.assignedAt.getTime() / 1000), to: r.a.revokedAt ? Math.floor(r.a.revokedAt.getTime() / 1000) : Number.MAX_SAFE_INTEGER }));
}
const holderAt = (h: Holding[], t: number) => h.find((x) => t >= x.from && t < x.to) ?? null;

async function cardRow(orgId: string, cardId: string) {
  const [card] = await db.select().from(schema.treasuryCards).where(and(eq(schema.treasuryCards.id, cardId), eq(schema.treasuryCards.organisationId, orgId)));
  if (!card) throw new AppError("not_found", "Card not found");
  return card;
}

/** Admin view of one card: recent authorisations + posted transactions with the staff who held the card at the time, and their notes/receipts. */
export async function adminCardActivity(orgId: string, cardId: string) {
  const card = await cardRow(orgId, cardId);
  const gw = await treasuryGateway(orgId, card.livemode ? "live" : "test");
  let auths: Stripe.Issuing.Authorization[], txns: Stripe.Issuing.Transaction[];
  try { [auths, txns] = await Promise.all([gw.listAuthorizations(card.stripeCardId, 100), gw.listTransactions(card.stripeCardId, 100)]); }
  catch (e) { throw new AppError("invalid_state", `Could not load card activity: ${safeStripeError(e)}`); }
  const [h, notes] = await Promise.all([holdings(card.id), db.select().from(schema.treasuryExpenses).where(eq(schema.treasuryExpenses.cardId, card.id))]);
  const note = (id: string) => notes.find((n) => n.stripeObjectId === id);
  const item = (kind: "authorization" | "transaction", o: { id: string; amount: number; currency: string; created: number; merchant_data: { name: string | null; category: string } }, status: string, declined: boolean) => {
    const n = note(o.id);
    return { id: o.id, kind, amount: o.amount, currency: o.currency, status, declined, merchant: o.merchant_data?.name ?? null, category: o.merchant_data?.category ?? null, createdAt: o.created, staffName: holderAt(h, o.created)?.staffName ?? null, note: n?.note ?? null, expenseId: n?.id ?? null, hasReceipt: !!n?.receiptObjectId };
  };
  const activity = [
    ...auths.map((a) => item("authorization", a, a.status, !a.approved && a.status === "closed")),
    ...txns.map((t) => item("transaction", t, t.type, false)),
  ].sort((x, y) => y.createdAt - x.createdAt);
  return { card: { id: card.id, last4: card.last4, brand: card.brand, currency: card.currency, status: card.status }, activity };
}

/** Expense notes and receipts for review, newest first. */
export async function listExpensesAdmin(orgId: string, mode: Mode, page: { limit: number; offset: number }) {
  const rows = await db.select({ e: schema.treasuryExpenses, staffName: schema.treasuryStaff.name, last4: schema.treasuryCards.last4 })
    .from(schema.treasuryExpenses)
    .innerJoin(schema.treasuryCards, eq(schema.treasuryCards.id, schema.treasuryExpenses.cardId))
    .leftJoin(schema.treasuryStaff, eq(schema.treasuryStaff.id, schema.treasuryExpenses.staffId))
    .where(and(eq(schema.treasuryExpenses.organisationId, orgId), eq(schema.treasuryCards.livemode, isLive(mode))))
    .orderBy(desc(schema.treasuryExpenses.updatedAt)).limit(page.limit).offset(page.offset);
  return rows.map((r) => ({ id: r.e.id, stripeObjectId: r.e.stripeObjectId, note: r.e.note, receiptName: r.e.receiptName, hasReceipt: !!r.e.receiptObjectId, staffName: r.staffName, last4: r.last4, cardId: r.e.cardId, updatedAt: r.e.updatedAt }));
}

export type ExpenseExportRow = { date: string; transactionId: string; type: string; amount: number; currency: string; merchant: string; category: string; city: string; country: string; cardLast4: string; cardNickname: string; cardholder: string; staff: string; note: string; receipt: string };
/** Posted card transactions in [from, to] across every card of the mode, with the holding staff, notes and receipt names. */
export async function expenseExport(a: Actor, mode: Mode, from: Date, to: Date): Promise<ExpenseExportRow[]> {
  if (!(from <= to)) throw new AppError("validation_failed", "The start date must be before the end date.");
  if (to.getTime() - from.getTime() > 400 * 86400_000) throw new AppError("validation_failed", "Export at most about 13 months at a time.");
  const cards = await db.select({ c: schema.treasuryCards, holder: schema.treasuryCardholders.name }).from(schema.treasuryCards)
    .innerJoin(schema.treasuryCardholders, eq(schema.treasuryCardholders.id, schema.treasuryCards.cardholderId))
    .where(and(eq(schema.treasuryCards.organisationId, a.orgId), eq(schema.treasuryCards.livemode, isLive(mode))));
  const gw = await treasuryGateway(a.orgId, mode);
  const fromS = Math.floor(from.getTime() / 1000), toS = Math.floor(to.getTime() / 1000);
  const out: ExpenseExportRow[] = [];
  for (const { c, holder } of cards) {
    let txns: Stripe.Issuing.Transaction[];
    try { txns = await gw.transactionsBetween(c.stripeCardId, fromS, toS); }
    catch (e) { throw new AppError("invalid_state", `Could not load transactions for card •••• ${c.last4 ?? "?"}: ${safeStripeError(e)}`); }
    if (!txns.length) continue;
    const [h, notes] = await Promise.all([holdings(c.id), db.select().from(schema.treasuryExpenses).where(eq(schema.treasuryExpenses.cardId, c.id))]);
    for (const t of txns) {
      const n = notes.find((x) => x.stripeObjectId === t.id || (typeof t.authorization === "string" ? t.authorization : t.authorization?.id) === x.stripeObjectId);
      out.push({ date: new Date(t.created * 1000).toISOString(), transactionId: t.id, type: t.type, amount: t.amount, currency: t.currency, merchant: t.merchant_data?.name ?? "", category: t.merchant_data?.category ?? "", city: t.merchant_data?.city ?? "", country: t.merchant_data?.country ?? "", cardLast4: c.last4 ?? "", cardNickname: c.nickname ?? "", cardholder: holder, staff: holderAt(h, t.created)?.staffName ?? "", note: n?.note ?? "", receipt: n?.receiptName ?? "" });
    }
  }
  out.sort((x, y) => x.date.localeCompare(y.date));
  await logTreasury(db, { orgId: a.orgId, actorType: "ADMIN", actorId: a.userId, actorName: a.userName, action: "expenses.exported", outcome: "OK", ip: a.ctx.ip, metadata: { mode, from: from.toISOString(), to: to.toISOString(), rows: out.length } });
  return out;
}

// ---------- audit & receipts ----------
export async function listAudit(orgId: string, page: { limit: number; offset: number }) {
  const [items, [{ n } = { n: 0 }]] = await Promise.all([
    db.select().from(schema.treasuryAudit).where(eq(schema.treasuryAudit.organisationId, orgId)).orderBy(desc(schema.treasuryAudit.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.treasuryAudit).where(eq(schema.treasuryAudit.organisationId, orgId)),
  ]);
  return { items, total: n };
}

export async function adminReceipt(orgId: string, expenseId: string) {
  const [row] = await db.select({ e: schema.treasuryExpenses, obj: schema.storageObjects })
    .from(schema.treasuryExpenses).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.treasuryExpenses.receiptObjectId))
    .where(and(eq(schema.treasuryExpenses.id, expenseId), eq(schema.treasuryExpenses.organisationId, orgId)));
  if (!row) throw new AppError("not_found", "Receipt not found");
  return { stream: await storage().getStream(row.obj.key), contentType: row.obj.contentType, name: row.e.receiptName ?? "receipt" };
}

export { Currency, type Actor };
