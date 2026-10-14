import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, bigint, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { organisations, storageObjects, users } from "./schema";

/**
 * Stripe Treasury staff card portal. Admins create Issuing cards funded by a Treasury financial account and assign one
 * to a staff member; staff log in to a separate portal (their own password + session, never a Stripe credential) and
 * see only the card assigned to them. Money is always integer minor units next to a lowercase ISO currency; everything
 * carries `livemode` so test and live never mix. No full card number (PAN) is ever stored — only brand/last4/expiry.
 */
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const org = () => uuid("organisation_id").notNull().references(() => organisations.id);
const money = (name: string) => bigint(name, { mode: "number" });

// ---------- Stripe-mirrored cardholders & cards ----------
export const treasuryCardholders = pgTable("treasury_cardholders", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  stripeCardholderId: text("stripe_cardholder_id").notNull(), // ich_…
  name: text("name").notNull(),
  email: text("email"),
  phoneNumber: text("phone_number"),
  type: text("type").notNull().default("individual"), // individual | company
  status: text("status").notNull().default("active"), // active | inactive | blocked
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("treasury_cardholders_uq").on(t.organisationId, t.stripeCardholderId), index("treasury_cardholders_org_idx").on(t.organisationId, t.livemode)]);

export const treasuryCards = pgTable("treasury_cards", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  stripeCardId: text("stripe_card_id").notNull(), // ic_…
  cardholderId: uuid("cardholder_id").notNull().references(() => treasuryCardholders.id),
  financialAccountId: text("financial_account_id"), // the Treasury financial account the card spends from (fa_…)
  brand: text("brand"),
  last4: text("last4"),
  expMonth: integer("exp_month"),
  expYear: integer("exp_year"),
  currency: text("currency").notNull(),
  type: text("type").notNull().default("virtual"), // virtual | physical
  status: text("status").notNull().default("active"), // active | inactive | canceled
  spendingControls: jsonb("spending_controls").notNull().default({}), // mirrored from Stripe: { spending_limits: [{amount, interval}], … }
  nickname: text("nickname"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("treasury_cards_uq").on(t.organisationId, t.stripeCardId), index("treasury_cards_org_idx").on(t.organisationId, t.livemode)]);

// ---------- staff identity (separate from org users) ----------
export const treasuryStaff = pgTable("treasury_staff", {
  id: id(),
  organisationId: org(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"), // null until the invite link is used to set one
  status: text("status").notNull().default("INVITED"), // INVITED | ACTIVE | SUSPENDED | REVOKED
  canFreezeCard: boolean("can_freeze_card").notNull().default(false), // policy: may this staff freeze/unfreeze their own card
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  suspendedBy: uuid("suspended_by").references(() => users.id),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("treasury_staff_email_uq").on(t.organisationId, sql`lower(${t.email})`), index("treasury_staff_org_idx").on(t.organisationId)]);

/** Single-use invite / password-reset links for staff. The raw token is never stored (only its HMAC). */
export const treasuryStaffTokens = pgTable("treasury_staff_tokens", {
  id: id(),
  staffId: uuid("staff_id").notNull().references(() => treasuryStaff.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(), // INVITE | RESET
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("treasury_staff_tokens_hash_uq").on(t.tokenHash), index("treasury_staff_tokens_staff_idx").on(t.staffId)]);

export const treasuryStaffSessions = pgTable("treasury_staff_sessions", {
  id: id(),
  staffId: uuid("staff_id").notNull().references(() => treasuryStaff.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  csrfToken: text("csrf_token").notNull(),
  ip: text("ip"), userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("treasury_staff_sessions_token_uq").on(t.tokenHash), index("treasury_staff_sessions_staff_idx").on(t.staffId)]);

/** The card(s) a staff member may see. Active when revoked_at is null; history is kept, never deleted. */
export const treasuryAssignments = pgTable("treasury_assignments", {
  id: id(),
  organisationId: org(),
  staffId: uuid("staff_id").notNull().references(() => treasuryStaff.id),
  cardId: uuid("card_id").notNull().references(() => treasuryCards.id),
  assignedBy: uuid("assigned_by").references(() => users.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  revokedBy: uuid("revoked_by").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("treasury_assignments_active_uq").on(t.cardId).where(sql`${t.revokedAt} is null`), // a card is assigned to at most one staff at a time
  index("treasury_assignments_staff_idx").on(t.staffId),
]);

// ---------- expense notes & receipts ----------
export const treasuryExpenses = pgTable("treasury_expenses", {
  id: id(),
  organisationId: org(),
  cardId: uuid("card_id").notNull().references(() => treasuryCards.id),
  staffId: uuid("staff_id").references(() => treasuryStaff.id),
  stripeObjectId: text("stripe_object_id").notNull(), // the authorization (iauth_…) or transaction (ipi_…/ipb_… via issuing) this note is about
  note: text("note"),
  receiptObjectId: uuid("receipt_object_id").references(() => storageObjects.id),
  receiptName: text("receipt_name"),
  createdBy: uuid("created_by").references(() => users.id), // null when written by staff; set when an admin edits
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("treasury_expenses_uq").on(t.organisationId, t.stripeObjectId), index("treasury_expenses_card_idx").on(t.cardId)]);

// ---------- spending-limit change requests ----------
export const treasuryLimitRequests = pgTable("treasury_limit_requests", {
  id: id(),
  organisationId: org(),
  staffId: uuid("staff_id").notNull().references(() => treasuryStaff.id),
  cardId: uuid("card_id").notNull().references(() => treasuryCards.id),
  interval: text("interval").notNull().default("monthly"), // per_authorization | daily | weekly | monthly | yearly | all_time
  currentAmount: money("current_amount"),
  requestedAmount: money("requested_amount").notNull(),
  currency: text("currency").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("PENDING"), // PENDING | APPROVED | REJECTED
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  createdAt: createdAt(),
}, (t) => [index("treasury_limit_requests_org_idx").on(t.organisationId, t.status), index("treasury_limit_requests_staff_idx").on(t.staffId), check("treasury_limit_requests_amount_ck", sql`${t.requestedAmount} >= 0`)]);

// ---------- webhook idempotency ----------
export const treasuryStripeEvents = pgTable("treasury_stripe_events", {
  id: id(),
  organisationId: org(),
  stripeEventId: text("stripe_event_id").notNull(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("treasury_stripe_events_uq").on(t.stripeEventId)]);

// ---------- audit ----------
export const treasuryAudit = pgTable("treasury_audit", {
  id: id(),
  organisationId: org(),
  actorType: text("actor_type").notNull(), // STAFF | ADMIN | SYSTEM
  actorId: text("actor_id"), // staff id or user id
  actorName: text("actor_name"),
  action: text("action").notNull(),
  resource: text("resource"),
  resourceId: text("resource_id"),
  outcome: text("outcome").notNull(), // OK | DENY | FAIL
  ip: text("ip"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("treasury_audit_org_idx").on(t.organisationId, t.createdAt.desc()), index("treasury_audit_actor_idx").on(t.actorType, t.actorId)]);
