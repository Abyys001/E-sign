import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, primaryKey, bigserial, bigint, real, pgEnum,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const contractStatus = pgEnum("contract_status", [
  "DRAFT", "READY_TO_SEND", "SENT", "DELIVERED", "VIEWED", "PARTIALLY_SIGNED",
  "AWAITING_SIGNATURE", "COMPLETED", "DECLINED", "CANCELLED", "EXPIRED", "VOIDED", "ARCHIVED",
]);
export const recipientRole = pgEnum("recipient_role", ["SIGNER", "CC", "WITNESS", "APPROVER"]);
export const recipientStatus = pgEnum("recipient_status", [
  "PENDING", "WAITING", "SENT", "VIEWED", "COMPLETED", "DECLINED", "REMOVED",
]);

// ---------- tenancy / identity ----------
export const organisations = pgTable("organisations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  settings: jsonb("settings").notNull().default({}),
  branding: jsonb("branding").notNull().default({}),
  contractSeq: integer("contract_seq").notNull().default(0),
  createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [uniqueIndex("organisations_slug_uq").on(t.slug)]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  locale: text("locale").notNull().default("en"),
  totpSecretEnc: text("totp_secret_enc"),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const roles = pgTable("roles", {
  id: id(),
  organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  isSystem: boolean("is_system").notNull().default(false),
}, (t) => [uniqueIndex("roles_org_key_uq").on(t.organisationId, t.key)]);

export const memberships = pgTable("memberships", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleKey: text("role_key").notNull(),
  grants: text("grants").array().notNull().default(sql`'{}'::text[]`),
  denies: text("denies").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("memberships_org_user_uq").on(t.organisationId, t.userId), index("memberships_user_idx").on(t.userId)]);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  activeOrganisationId: uuid("active_organisation_id").references(() => organisations.id),
  tokenHash: text("token_hash").notNull(),
  csrfToken: text("csrf_token").notNull(),
  ip: text("ip"), userAgent: text("user_agent"),
  elevatedUntil: timestamp("elevated_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)]);

// ---------- storage ----------
export const storageObjects = pgTable("storage_objects", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  key: text("key").notNull(),
  provider: text("provider").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  contentType: text("content_type").notNull(),
  purgedAt: timestamp("purged_at", { withTimezone: true }), // bytes deleted by a retention policy; the row and hashes stay as evidence
  createdAt: createdAt(),
}, (t) => [uniqueIndex("storage_objects_key_uq").on(t.key), index("storage_objects_org_idx").on(t.organisationId)]);

// ---------- templates ----------
export const templates = pgTable("templates", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  contractType: text("contract_type").notNull().default("general"),
  status: text("status").notNull().default("DRAFT"), // DRAFT | PUBLISHED | ARCHIVED
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("templates_org_status_idx").on(t.organisationId, t.status)]);

export const templateVersions = pgTable("template_versions", {
  id: id(),
  templateId: uuid("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  version: integer("version").notNull(),
  storageObjectId: uuid("storage_object_id").references(() => storageObjects.id),
  variables: jsonb("variables").notNull().default([]),
  fields: jsonb("fields").notNull().default([]),
  recipientRoles: jsonb("recipient_roles").notNull().default([]),
  published: boolean("published").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("template_versions_uq").on(t.templateId, t.version)]);

// ---------- contracts ----------
export const contracts = pgTable("contracts", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  reference: text("reference").notNull(),
  name: text("name").notNull(),
  contractType: text("contract_type").notNull().default("general"),
  status: contractStatus("status").notNull().default("DRAFT"),
  templateVersionId: uuid("template_version_id").references(() => templateVersions.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  signingOrder: text("signing_order").notNull().default("SEQUENTIAL"), // SEQUENTIAL | PARALLEL | CUSTOM
  currentVersionId: uuid("current_version_id"),
  signingVersionId: uuid("signing_version_id"), // frozen once SENT
  finalVersionId: uuid("final_version_id"),
  metadata: jsonb("metadata").notNull().default({}),
  message: text("message"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  verificationId: text("verification_id"),
  documentsPurgedAt: timestamp("documents_purged_at", { withTimezone: true }),
  agreementTemplateVersionId: uuid("agreement_template_version_id"), // clause-generated contracts: the exact template version used
  intakeSubmissionId: uuid("intake_submission_id"), // source intake submission (traceability)
  generationKey: text("generation_key"), // `${submissionId}:${rev}`; unique => a retry can never create a second contract
  generationManifest: jsonb("generation_manifest"), // exact inputs: clause versions, variables, policies, jurisdiction, hashes
  legalFlags: jsonb("legal_flags").notNull().default([]),
  searchText: text("search_text").notNull().default(""), // name + reference + recipients + key metadata; trigram-indexed for scalable ILIKE
  rev: integer("rev").notNull().default(0), // optimistic lock
  createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("contracts_org_ref_uq").on(t.organisationId, t.reference),
  uniqueIndex("contracts_verification_uq").on(t.verificationId),
  index("contracts_org_status_idx").on(t.organisationId, t.status),
  uniqueIndex("contracts_generation_key_uq").on(t.generationKey),
  index("contracts_intake_submission_idx").on(t.intakeSubmissionId),
  index("contracts_org_created_idx").on(t.organisationId, t.createdAt.desc()),
  index("contracts_expires_idx").on(t.expiresAt).where(sql`status in ('SENT','DELIVERED','VIEWED','PARTIALLY_SIGNED','AWAITING_SIGNATURE')`),
  index("contracts_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
  index("contracts_search_trgm").using("gin", sql`${t.searchText} gin_trgm_ops`),
]);

export const contractVersions = pgTable("contract_versions", {
  id: id(),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  version: integer("version").notNull(),
  kind: text("kind").notNull().default("SOURCE"), // SOURCE | FINAL
  storageObjectId: uuid("storage_object_id").notNull().references(() => storageObjects.id),
  sha256: text("sha256").notNull(),
  pageCount: integer("page_count").notNull(),
  pageDims: jsonb("page_dims").notNull(), // [{w,h}] in PDF points
  changeReason: text("change_reason"),
  locked: boolean("locked").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("contract_versions_uq").on(t.contractId, t.version, t.kind), index("contract_versions_org_idx").on(t.organisationId)]);

export const recipients = pgTable("recipients", {
  id: id(),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  company: text("company"),
  role: recipientRole("role").notNull().default("SIGNER"),
  status: recipientStatus("status").notNull().default("PENDING"),
  signingOrder: integer("signing_order").notNull().default(1),
  required: boolean("required").notNull().default(true),
  internal: boolean("internal").notNull().default(false),
  authLevel: text("auth_level").notNull().default("LINK"), // LINK | EMAIL_OTP | SMS_OTP | PASSCODE | ACCOUNT
  passcodeHash: text("passcode_hash"),
  smsConsent: boolean("sms_consent").notNull().default(false),
  viewedAt: timestamp("viewed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  declineReason: text("decline_reason"),
  createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("recipients_contract_idx").on(t.contractId),
  index("recipients_org_email_idx").on(t.organisationId, sql`lower(${t.email})`),
  index("recipients_status_idx").on(t.status),
]);

export const recipientFields = pgTable("recipient_fields", {
  id: id(),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  recipientId: uuid("recipient_id").notNull().references(() => recipients.id),
  key: text("key").notNull(), // internal identifier
  type: text("type").notNull(),
  label: text("label").notNull().default(""),
  page: integer("page").notNull(), // 0-based page index (matches the PDF stamping code)
  // fractions (0..1) of page width/height, origin top-left: independent of viewport and page size
  x: real("x").notNull(), y: real("y").notNull(), w: real("w").notNull(), h: real("h").notNull(),
  required: boolean("required").notNull().default(true),
  defaultValue: text("default_value"),
  options: jsonb("options").$type<string[]>().notNull().default([]),
  validation: jsonb("validation").$type<Record<string, unknown>>().notNull().default({}),
  value: jsonb("value"),
  filledAt: timestamp("filled_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("recipient_fields_contract_idx").on(t.contractId), index("recipient_fields_recipient_idx").on(t.recipientId), uniqueIndex("recipient_fields_key_uq").on(t.contractId, t.key)]);

// ---------- signing ----------
export const signatureRequests = pgTable("signature_requests", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  recipientId: uuid("recipient_id").notNull().references(() => recipients.id),
  tokenHash: text("token_hash").notNull(),
  // token = HMAC(SIGNING_TOKEN_SECRET, id:nonce). Only the hash is queryable; the link is re-derivable server-side for email jobs.
  tokenNonce: text("token_nonce").notNull(),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | USED | REVOKED | EXPIRED
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  sessionHash: text("session_hash"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("signature_requests_token_uq").on(t.tokenHash), index("signature_requests_recipient_idx").on(t.recipientId), index("signature_requests_expires_idx").on(t.expiresAt)]);

export const signatures = pgTable("signatures", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  recipientId: uuid("recipient_id").notNull().references(() => recipients.id),
  fieldId: uuid("field_id").references(() => recipientFields.id),
  method: text("method").notNull(), // TYPED | DRAWN | UPLOADED | INITIALS
  typedText: text("typed_text"),
  typedFont: text("typed_font"),
  imageObjectId: uuid("image_object_id").references(() => storageObjects.id),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  ip: text("ip"), userAgent: text("user_agent"), device: jsonb("device").notNull().default({}),
  documentHash: text("document_hash").notNull(),
  signingSessionId: uuid("signing_session_id").notNull(),
  authMethod: text("auth_method").notNull(),
}, (t) => [index("signatures_contract_idx").on(t.contractId), index("signatures_recipient_idx").on(t.recipientId)]);

export const consents = pgTable("consents", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  recipientId: uuid("recipient_id").notNull().references(() => recipients.id),
  kind: text("kind").notNull().default("ESIGN"),
  text: text("text").notNull(),
  textHash: text("text_hash").notNull(),
  locale: text("locale").notNull(),
  ip: text("ip"), userAgent: text("user_agent"),
  givenAt: timestamp("given_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("consents_recipient_idx").on(t.recipientId)]);

export const otpSessions = pgTable("otp_sessions", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  recipientId: uuid("recipient_id").notNull().references(() => recipients.id),
  signatureRequestId: uuid("signature_request_id").notNull().references(() => signatureRequests.id),
  channel: text("channel").notNull(), // EMAIL | SMS
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ip: text("ip"),
  createdAt: createdAt(),
}, (t) => [index("otp_sessions_request_idx").on(t.signatureRequestId, t.createdAt.desc())]);

export const completionCertificates = pgTable("completion_certificates", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  certificateId: text("certificate_id").notNull(),
  storageObjectId: uuid("storage_object_id").notNull().references(() => storageObjects.id),
  finalDocumentHash: text("final_document_hash").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("completion_certificates_contract_uq").on(t.contractId), uniqueIndex("completion_certificates_cert_uq").on(t.certificateId)]);

// ---------- audit (append-only; enforced by trigger in 0001_audit_immutable.sql) ----------
export const auditEvents = pgTable("audit_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: uuid("id").notNull().default(sql`gen_random_uuid()`),
  organisationId: uuid("organisation_id").notNull(),
  contractId: uuid("contract_id"),
  userId: uuid("user_id"),
  recipientId: uuid("recipient_id"),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  ip: text("ip"), userAgent: text("user_agent"), device: jsonb("device"),
  correlationId: text("correlation_id"),
  metadata: jsonb("metadata").notNull().default({}),
  documentHash: text("document_hash"),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
}, (t) => [
  uniqueIndex("audit_events_id_uq").on(t.id),
  index("audit_events_contract_idx").on(t.contractId, t.seq),
  index("audit_events_org_time_idx").on(t.organisationId, t.occurredAt.desc()),
  index("audit_events_type_idx").on(t.eventType),
]);

// ---------- messaging ----------
export const emailMessages = pgTable("email_messages", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").references(() => contracts.id),
  recipientId: uuid("recipient_id").references(() => recipients.id),
  template: text("template").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  messageId: text("message_id"),
  status: text("status").notNull().default("QUEUED"), // QUEUED | SENDING | SENT | DELIVERED | BOUNCED | COMPLAINED | FAILED | SUPPRESSED (opened/clicked are timestamps, not statuses)
  providerResponse: text("provider_response"),
  error: text("error"),
  dedupeKey: text("dedupe_key"),
  payload: jsonb("payload").notNull().default({}), // template variables (no secrets)
  locale: text("locale").notNull().default("en"),
  attempts: integer("attempts").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  sendingAt: timestamp("sending_at", { withTimezone: true }), // set atomically when a worker claims the message
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("email_messages_contract_idx").on(t.contractId), index("email_messages_org_status_idx").on(t.organisationId, t.status), uniqueIndex("email_messages_dedupe_uq").on(t.dedupeKey)]);

export const emailEvents = pgTable("email_events", {
  id: id(),
  emailMessageId: uuid("email_message_id").notNull().references(() => emailMessages.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").notNull(),
  type: text("type").notNull(), // DELIVERED | BOUNCE | COMPLAINT | OPEN | CLICK
  payload: jsonb("payload").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("email_events_message_idx").on(t.emailMessageId), uniqueIndex("email_events_uq").on(t.emailMessageId, t.type, t.occurredAt)]);

/** Addresses that bounced or complained. Sends to them are refused (status SUPPRESSED) until a person removes the row. */
export const emailSuppressions = pgTable("email_suppressions", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  email: text("email").notNull(),
  reason: text("reason").notNull(), // BOUNCE | COMPLAINT
  sourceMessageId: uuid("source_message_id"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("email_suppressions_uq").on(t.organisationId, t.email)]);

export const smsMessages = pgTable("sms_messages", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").references(() => contracts.id),
  recipientId: uuid("recipient_id").references(() => recipients.id),
  template: text("template").notNull(),
  toPhone: text("to_phone").notNull(),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id"),
  status: text("status").notNull().default("QUEUED"), // QUEUED | SENT | DELIVERED | FAILED | NOT_SENT
  error: text("error"),
  dedupeKey: text("dedupe_key"),
  payload: jsonb("payload").notNull().default({}),
  locale: text("locale").notNull().default("en"),
  attempts: integer("attempts").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("sms_messages_contract_idx").on(t.contractId), uniqueIndex("sms_messages_dedupe_uq").on(t.dedupeKey)]);

export const reminders = pgTable("reminders", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  recipientId: uuid("recipient_id").notNull().references(() => recipients.id),
  kind: text("kind").notNull(), // MANUAL | AUTO_AFTER | AUTO_BEFORE_EXPIRY
  slot: text("slot").notNull(), // e.g. after:24h, before:1d, manual:<uuid>
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("reminders_slot_uq").on(t.recipientId, t.slot)]);

export const notifications = pgTable("notifications", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  contractId: uuid("contract_id").references(() => contracts.id),
  type: text("type").notNull(),
  data: jsonb("data").notNull().default({}),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt.desc())]);

export const downloads = pgTable("downloads", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  userId: uuid("user_id").references(() => users.id),
  recipientId: uuid("recipient_id").references(() => recipients.id),
  artifact: text("artifact").notNull(), // SOURCE | FINAL | CERTIFICATE | AUDIT_EXPORT
  ip: text("ip"), userAgent: text("user_agent"),
  createdAt: createdAt(),
}, (t) => [index("downloads_contract_idx").on(t.contractId)]);

// ---------- webhooks ----------
export const webhooks = pgTable("webhooks", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  events: text("events").array().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index("webhooks_org_idx").on(t.organisationId)]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(), // also X-Webhook-ID
  webhookId: uuid("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").notNull(),
  event: text("event").notNull(),
  eventKey: text("event_key").notNull(), // idempotency: one delivery per (webhook, event occurrence)
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING | SUCCESS | FAILED
  attempts: integer("attempts").notNull().default(0),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("webhook_deliveries_key_uq").on(t.webhookId, t.eventKey), index("webhook_deliveries_org_idx").on(t.organisationId, t.createdAt.desc())]);

export const emailTemplates = pgTable("email_templates", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  key: text("key").notNull(),
  locale: text("locale").notNull().default("en"),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("email_templates_uq").on(t.organisationId, t.key, t.locale)]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").notNull(),
  scope: text("scope").notNull(),
  organisationId: uuid("organisation_id").notNull(),
  response: jsonb("response"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.scope, t.key] })]);

export const rateLimits = pgTable("rate_limits", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  permissions: text("permissions").array().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_org_idx").on(t.organisationId)]);

export const userTokens = pgTable("user_tokens", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(), // INVITE | PASSWORD_RESET
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("user_tokens_hash_uq").on(t.tokenHash)]);

// ---------- clause library (versioned; published versions are immutable, see drizzle/0005) ----------
export const clauses = pgTable("clauses", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  key: text("key").notNull(), // stable slug, e.g. "ticketing.exclusivity"
  category: text("category").notNull(),
  module: text("module").notNull().default("core"), // core | ticketing | venue | production | marketing | staffing | artist | supplier | event_day
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("clauses_org_key_uq").on(t.organisationId, t.key)]);

export const clauseVersions = pgTable("clause_versions", {
  id: id(),
  clauseId: uuid("clause_id").notNull().references(() => clauses.id),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  version: integer("version").notNull(),
  language: text("language").notNull().default("en"),
  jurisdiction: text("jurisdiction").notNull().default("ANY"), // ANY | ENG | SCO | ... | region prefix (UK, EU, US)
  status: text("status").notNull().default("DRAFT"), // DRAFT | PUBLISHED | RETIRED
  reviewStatus: text("review_status").notNull().default("unreviewed"), // unreviewed | in_review | approved
  body: text("body").notNull(),
  variableSchema: jsonb("variable_schema").notNull().default([]),
  condition: jsonb("condition"),
  authorId: uuid("author_id").references(() => users.id),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("clause_versions_uq").on(t.clauseId, t.language, t.jurisdiction, t.version), index("clause_versions_org_idx").on(t.organisationId, t.status)]);

export const agreementTemplates = pgTable("agreement_templates", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  agreementType: text("agreement_type").notNull(),
  status: text("status").notNull().default("DRAFT"), // DRAFT | PUBLISHED | ARCHIVED
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("agreement_templates_org_idx").on(t.organisationId, t.status)]);

export const agreementTemplateVersions = pgTable("agreement_template_versions", {
  id: id(),
  templateId: uuid("template_id").notNull().references(() => agreementTemplates.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  version: integer("version").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  language: text("language").notNull().default("en"),
  modules: jsonb("modules").notNull().default([]),
  clauseSelection: jsonb("clause_selection").notNull().default([]), // [{clauseKey, versionId, required, condition?}]
  policyConfig: jsonb("policy_config").notNull().default({}), // exclusivity, moneyFlow, refund, obligations, execution
  variables: jsonb("variables").notNull().default([]), // custom VariableDef[]
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("agreement_template_versions_uq").on(t.templateId, t.version)]);

// ---------- intake forms ----------
export const intakeForms = pgTable("intake_forms", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("DRAFT"), // DRAFT | PUBLISHED | ARCHIVED
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("intake_forms_org_idx").on(t.organisationId, t.status)]);

export const intakeFormVersions = pgTable("intake_form_versions", {
  id: id(),
  formId: uuid("form_id").notNull().references(() => intakeForms.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  version: integer("version").notNull(),
  agreementTemplateVersionId: uuid("agreement_template_version_id").references(() => agreementTemplateVersions.id),
  schema: jsonb("schema").notNull().default({}), // sections, fields, validation, conditions, variable mapping
  workflow: text("workflow").notNull().default("B"), // A auto-send | B draft for review | C PDF for manual send | D store only
  settings: jsonb("settings").notNull().default({}), // branding, expiry, privacy notice, reminders, notify email, signer mapping
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("intake_form_versions_uq").on(t.formId, t.version)]);

export const intakeInvitations = pgTable("intake_invitations", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  formId: uuid("form_id").notNull().references(() => intakeForms.id),
  formVersionId: uuid("form_version_id").notNull().references(() => intakeFormVersions.id),
  recipientName: text("recipient_name").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  tokenHash: text("token_hash").notNull(), // HMAC of the bearer token; raw token exists only in the email
  tokenNonce: text("token_nonce").notNull(), // token is re-derived from (id, nonce) inside the email job; never stored
  firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  openCount: integer("open_count").notNull().default(0), // meaningful visits (new session or return after inactivity), not requests
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastSavedAt: timestamp("last_saved_at", { withTimezone: true }),
  status: text("status").notNull().default("SENT"), // SENT | REVOKED (EXPIRED is derived from expires_at)
  authMode: text("auth_mode").notNull().default("NONE"), // NONE | EMAIL_OTP | PASSCODE
  passcodeHash: text("passcode_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("intake_invitations_token_uq").on(t.tokenHash), index("intake_invitations_org_idx").on(t.organisationId, t.formId)]);

export const intakeSubmissions = pgTable("intake_submissions", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  formId: uuid("form_id").notNull().references(() => intakeForms.id),
  formVersionId: uuid("form_version_id").notNull().references(() => intakeFormVersions.id),
  invitationId: uuid("invitation_id").notNull().references(() => intakeInvitations.id),
  status: text("status").notNull().default("DRAFT"), // DRAFT | SUBMITTED | REOPENED
  answers: jsonb("answers").notNull().default({}), // organiser answers only; telemetry lives in separate tables
  rev: integer("rev").notNull().default(0), // bumped on every save; submissionRev bumps on reopen+resubmit
  submissionRev: integer("submission_rev").notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  contractId: uuid("contract_id").references(() => contracts.id),
  generationStatus: text("generation_status").notNull().default("NONE"), // NONE | QUEUED | RUNNING | DONE | FAILED | HALTED
  generationError: text("generation_error"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("intake_submissions_invitation_uq").on(t.invitationId), index("intake_submissions_org_idx").on(t.organisationId, t.formId)]);

// ---------- intake: access telemetry (separate from answers by design) ----------
export const intakeAccessSessions = pgTable("intake_access_sessions", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  formId: uuid("form_id").notNull().references(() => intakeForms.id),
  formVersionId: uuid("form_version_id").notNull().references(() => intakeFormVersions.id),
  invitationId: uuid("invitation_id").notNull().references(() => intakeInvitations.id),
  sessionHash: text("session_hash").notNull(), // HMAC of the browser cookie; the raw cookie and the link token are never stored
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  ip: text("ip"),
  ipVersion: integer("ip_version"),
  userAgent: text("user_agent"),
  browser: text("browser"), browserVersion: text("browser_version"),
  os: text("os"), osVersion: text("os_version"),
  deviceType: text("device_type"), // desktop | mobile | tablet | unknown
  deviceKey: text("device_key"), // hash of normalised browser/os/device/screen/language/tz; coarse grouping only, never an identity
  screenWidth: integer("screen_width"), screenHeight: integer("screen_height"), pixelRatio: real("pixel_ratio"),
  language: text("language"), timezone: text("timezone"), platform: text("platform"), referrer: text("referrer"),
  pageVisits: integer("page_visits").notNull().default(1),
  activeSeconds: integer("active_seconds").notNull().default(0),
  sectionProgress: jsonb("section_progress").notNull().default({}), // {sectionKey: "entered" | "completed"}; no answer values
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("intake_access_sessions_hash_uq").on(t.sessionHash),
  index("intake_access_sessions_org_idx").on(t.organisationId, t.formId),
  index("intake_access_sessions_inv_idx").on(t.invitationId, t.lastSeenAt.desc()),
  index("intake_access_sessions_ip_idx").on(t.ip),
  index("intake_access_sessions_seen_idx").on(t.lastSeenAt),
]);

export const intakeAccessEvents = pgTable("intake_access_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organisationId: uuid("organisation_id").notNull(),
  formId: uuid("form_id").notNull(),
  invitationId: uuid("invitation_id").notNull(),
  sessionId: uuid("session_id"),
  type: text("type").notNull(), // intake.opened | session_started | session_resumed | returned | form_started | field_interaction | draft_saved | submission_started | submitted | link_expired | link_revoked | session_expired
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  ip: text("ip"),
  metadata: jsonb("metadata").notNull().default({}),
}, (t) => [
  index("intake_access_events_inv_idx").on(t.invitationId, t.occurredAt.desc()),
  index("intake_access_events_org_idx").on(t.organisationId, t.occurredAt.desc()),
  index("intake_access_events_session_idx").on(t.sessionId),
  index("intake_access_events_ip_idx").on(t.ip),
]);

export const intakeOtps = pgTable("intake_otps", {
  id: id(),
  organisationId: uuid("organisation_id").notNull(),
  invitationId: uuid("invitation_id").notNull().references(() => intakeInvitations.id),
  sessionId: uuid("session_id").notNull().references(() => intakeAccessSessions.id),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [index("intake_otps_inv_idx").on(t.invitationId, t.createdAt.desc())]);

export const intakeFiles = pgTable("intake_files", {
  id: id(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  submissionId: uuid("submission_id").notNull().references(() => intakeSubmissions.id),
  fieldKey: text("field_key").notNull(),
  storageObjectId: uuid("storage_object_id").notNull().references(() => storageObjects.id),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: createdAt(),
}, (t) => [index("intake_files_sub_idx").on(t.submissionId)]);

export const intakeReminders = pgTable("intake_reminders", {
  id: id(),
  organisationId: uuid("organisation_id").notNull(),
  invitationId: uuid("invitation_id").notNull().references(() => intakeInvitations.id),
  slot: text("slot").notNull(), // e.g. "after_h:24", "before_h:48"; unique per invitation => never sent twice
  emailMessageId: uuid("email_message_id"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("intake_reminders_uq").on(t.invitationId, t.slot)]);
export * from "./accounting-schema";
