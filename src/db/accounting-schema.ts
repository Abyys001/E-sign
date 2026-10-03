import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, bigserial, bigint, date, check } from "drizzle-orm/pg-core";
import { organisations, users } from "./schema";

/**
 * Accounting & Stripe finance. Money is always integer minor units (bigint, JS number: exact to 2^53) next to a lowercase
 * ISO currency code. Every Stripe-derived and ledger row carries `livemode` so test and live data can never mix.
 * Ledger rows are append-only (triggers in 0009_accounting.sql); corrections are reversals, never edits or deletes.
 */
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: "number" });
const org = () => uuid("organisation_id").notNull().references(() => organisations.id);

// ---------- configuration ----------
export const acctSettings = pgTable("acct_settings", {
  organisationId: uuid("organisation_id").primaryKey().references(() => organisations.id),
  baseCurrency: text("base_currency").notNull().default("eur"),
  defaultMode: text("default_mode").notNull().default("test"), // test | live: which Stripe environment the finance screens open on
  matchRules: jsonb("match_rules").notNull().default([]), // ordered event-code extraction rules, see server/accounting/matcher.ts
  ticketQuantityKey: text("ticket_quantity_key").notNull().default("quantity"), // Stripe metadata key holding the ticket count
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

export const stripeAccounts = pgTable("stripe_accounts", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  stripeAccountId: text("stripe_account_id"), // acct_… as reported by Stripe
  displayName: text("display_name"),
  secretKeyEnc: text("secret_key_enc"), // AES-256-GCM; never returned by any API
  keyHint: text("key_hint"), // e.g. "rk_live_…a1b2"
  webhookSecretEnc: text("webhook_secret_enc"),
  webhookSecretHint: text("webhook_secret_hint"),
  webhookEndpointId: text("webhook_endpoint_id"),
  status: text("status").notNull().default("DISCONNECTED"), // CONNECTED | ERROR | DISCONNECTED
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
  lastWebhookType: text("last_webhook_type"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("stripe_accounts_org_mode_uq").on(t.organisationId, t.livemode)]);

// ---------- organisers / events / agreements ----------
export const acctOrganisers = pgTable("acct_organisers", {
  id: id(),
  organisationId: org(),
  name: text("name").notNull(),
  email: text("email"),
  companyName: text("company_name"),
  vatNumber: text("vat_number"),
  address: text("address"),
  internalRef: text("internal_ref"),
  bankDetailsEnc: text("bank_details_enc"), // encrypted JSON {accountHolder, iban, bic, bankName, notes}
  bankHint: text("bank_hint"), // masked, e.g. "DE89 …3000"
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_organisers_org_idx").on(t.organisationId, t.name),
  uniqueIndex("acct_organisers_ref_uq").on(t.organisationId, sql`lower(${t.internalRef})`).where(sql`${t.internalRef} is not null`),
]);

export const acctEvents = pgTable("acct_events", {
  id: id(),
  organisationId: org(),
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  name: text("name").notNull(),
  code: text("code").notNull(), // matched case-insensitively against Stripe metadata/descriptions
  currency: text("currency").notNull(),
  startsOn: date("starts_on"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | INACTIVE | ARCHIVED
  currentAgreementId: uuid("current_agreement_id"),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("acct_events_code_uq").on(t.organisationId, sql`upper(${t.code})`),
  index("acct_events_organiser_idx").on(t.organiserId),
]);

/** Commercial agreement for an event. Versioned and immutable: each sale records the version it was calculated with. */
export const acctAgreements = pgTable("acct_agreements", {
  id: id(),
  organisationId: org(),
  eventId: uuid("event_id").notNull().references(() => acctEvents.id),
  version: integer("version").notNull(),
  percentBps: integer("percent_bps").notNull().default(0), // 500 = 5.00 %
  percentBasis: text("percent_basis").notNull().default("GROSS"), // GROSS | NET (net = gross − Stripe fee)
  fixedPerTicket: money("fixed_per_ticket").notNull().default(0),
  fixedEventFee: money("fixed_event_fee").notNull().default(0),
  stripeFeesBorneBy: text("stripe_fees_borne_by").notNull().default("ORGANISER"), // ORGANISER | BILIT
  chargebacksBorneBy: text("chargebacks_borne_by").notNull().default("ORGANISER"),
  refundsReverseCommission: boolean("refunds_reverse_commission").notNull().default(true),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("acct_agreements_event_version_uq").on(t.eventId, t.version),
  check("acct_agreements_bps_ck", sql`${t.percentBps} between 0 and 10000`),
  check("acct_agreements_fixed_ck", sql`${t.fixedPerTicket} >= 0 and ${t.fixedEventFee} >= 0`),
]);

// ---------- Stripe mirror ----------
export const stripeEvents = pgTable("stripe_events", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  eventId: text("event_id").notNull(),
  type: text("type").notNull(),
  objectId: text("object_id"),
  apiVersion: text("api_version"),
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("RECEIVED"), // RECEIVED | PROCESSED | IGNORED | FAILED
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("stripe_events_uq").on(t.stripeAccountRef, t.eventId),
  index("stripe_events_org_idx").on(t.organisationId, t.livemode, t.receivedAt.desc()),
]);

export const stripeCharges = pgTable("stripe_charges", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  chargeId: text("charge_id").notNull(),
  paymentIntentId: text("payment_intent_id"),
  balanceTransactionId: text("balance_transaction_id"),
  amount: money("amount").notNull(),
  amountCaptured: money("amount_captured").notNull().default(0),
  amountRefunded: money("amount_refunded").notNull().default(0),
  currency: text("currency").notNull(),
  status: text("status").notNull(), // succeeded | pending | failed
  paid: boolean("paid").notNull().default(false),
  refunded: boolean("refunded").notNull().default(false),
  disputed: boolean("disputed").notNull().default(false),
  description: text("description"),
  statementDescriptor: text("statement_descriptor"),
  customerId: text("customer_id"),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  metadata: jsonb("metadata").notNull().default({}),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("stripe_charges_uq").on(t.stripeAccountRef, t.chargeId),
  index("stripe_charges_org_idx").on(t.organisationId, t.livemode, t.stripeCreatedAt.desc()),
  index("stripe_charges_pi_idx").on(t.paymentIntentId),
]);

export const stripeRefunds = pgTable("stripe_refunds", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  refundId: text("refund_id").notNull(),
  chargeId: text("charge_id"),
  paymentIntentId: text("payment_intent_id"),
  balanceTransactionId: text("balance_transaction_id"),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status"),
  reason: text("reason"),
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("stripe_refunds_uq").on(t.stripeAccountRef, t.refundId), index("stripe_refunds_charge_idx").on(t.chargeId)]);

export const stripeDisputes = pgTable("stripe_disputes", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  disputeId: text("dispute_id").notNull(),
  chargeId: text("charge_id"),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  reason: text("reason"),
  status: text("status").notNull(),
  eventId: uuid("event_id").references(() => acctEvents.id),
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  accountingStatus: text("accounting_status").notNull().default("OPEN"), // OPEN | LOST | WON | MANUAL_REVIEW
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("stripe_disputes_uq").on(t.stripeAccountRef, t.disputeId), index("stripe_disputes_org_idx").on(t.organisationId, t.livemode, t.stripeCreatedAt.desc())]);

export const stripePayouts = pgTable("stripe_payouts", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  payoutId: text("payout_id").notNull(),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(), // paid | pending | in_transit | canceled | failed
  automatic: boolean("automatic").notNull().default(true),
  method: text("method"),
  description: text("description"),
  statementDescriptor: text("statement_descriptor"),
  balanceTransactionId: text("balance_transaction_id"),
  failureBalanceTransactionId: text("failure_balance_transaction_id"),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  arrivalDate: timestamp("arrival_date", { withTimezone: true }),
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
  includedCount: integer("included_count"),
  includedNet: money("included_net"),
  reconciliationStatus: text("reconciliation_status").notNull().default("UNMATCHED"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("stripe_payouts_uq").on(t.stripeAccountRef, t.payoutId), index("stripe_payouts_org_idx").on(t.organisationId, t.livemode, t.stripeCreatedAt.desc())]);

export const stripeBalanceTransactions = pgTable("stripe_balance_transactions", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  balanceTransactionId: text("balance_transaction_id").notNull(),
  type: text("type").notNull(),
  reportingCategory: text("reporting_category"),
  sourceId: text("source_id"),
  amount: money("amount").notNull(),
  fee: money("fee").notNull(),
  net: money("net").notNull(),
  currency: text("currency").notNull(),
  exchangeRate: text("exchange_rate"), // decimal string exactly as Stripe reported it; never used for silent conversion
  feeDetails: jsonb("fee_details").notNull().default([]),
  description: text("description"),
  stripeStatus: text("stripe_status"), // pending | available
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
  availableOn: timestamp("available_on", { withTimezone: true }),
  chargeId: text("charge_id"), // the charge itself, or the original charge of a refund/dispute
  payoutId: text("payout_id"), // the payout that paid this out (automatic payouts), or the payout itself
  // classification + matching
  kind: text("kind").notNull(), // SALE | REFUND | DISPUTE | DISPUTE_REVERSAL | PAYOUT | PAYOUT_REVERSAL | STRIPE_FEE | OTHER
  eventCode: text("event_code"),
  eventId: uuid("event_id").references(() => acctEvents.id),
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  agreementId: uuid("agreement_id").references(() => acctAgreements.id),
  matchStatus: text("match_status").notNull(), // MATCHED | UNMATCHED | NOT_APPLICABLE
  matchReason: text("match_reason"), // NO_CODE | CODE_NOT_FOUND | EVENT_INACTIVE | NO_ORGANISER | CURRENCY_MISMATCH | AMBIGUOUS | ORIGINAL_UNMATCHED | ORIGINAL_MISSING | UNCLASSIFIED
  matchMethod: text("match_method"), // METADATA | EXACT | PREFIX | REGEX | INHERITED | MANUAL
  reconciliationStatus: text("reconciliation_status").notNull(), // MATCHED | UNMATCHED | PARTIAL | DUPLICATE | REFUND | DISPUTE | MANUAL_REVIEW | ERROR
  reconciliationNote: text("reconciliation_note"),
  classificationAccountId: uuid("classification_account_id"), // manual classification for OTHER kinds
  ticketQuantity: integer("ticket_quantity"),
  commissionAmount: money("commission_amount"), // Bilit commission booked on this transaction (signed)
  organiserAmount: money("organiser_amount"), // net change of organiser payable (signed)
  postedEntryId: uuid("posted_entry_id"),
  postingVersion: integer("posting_version").notNull().default(0),
  matchedBy: uuid("matched_by").references(() => users.id),
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("stripe_bt_uq").on(t.stripeAccountRef, t.balanceTransactionId),
  index("stripe_bt_org_time_idx").on(t.organisationId, t.livemode, t.stripeCreatedAt.desc()),
  index("stripe_bt_recon_idx").on(t.organisationId, t.livemode, t.reconciliationStatus),
  index("stripe_bt_event_idx").on(t.eventId),
  index("stripe_bt_organiser_idx").on(t.organiserId),
  index("stripe_bt_charge_idx").on(t.chargeId),
  index("stripe_bt_payout_idx").on(t.payoutId),
  index("stripe_bt_source_idx").on(t.sourceId),
]);

// ---------- ledger ----------
export const acctAccounts = pgTable("acct_accounts", {
  id: id(),
  organisationId: org(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  systemKey: text("system_key"), // stable key used by automatic postings
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("acct_accounts_code_uq").on(t.organisationId, t.code),
  uniqueIndex("acct_accounts_system_uq").on(t.organisationId, t.systemKey).where(sql`${t.systemKey} is not null`),
]);

export const acctPeriods = pgTable("acct_periods", {
  id: id(),
  organisationId: org(),
  period: text("period").notNull(), // YYYY-MM
  status: text("status").notNull().default("OPEN"), // OPEN | CLOSED
  closedBy: uuid("closed_by").references(() => users.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  notes: text("notes"),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("acct_periods_uq").on(t.organisationId, t.period)]);

export const acctJournalEntries = pgTable("acct_journal_entries", {
  id: id(),
  seq: bigserial("seq", { mode: "number" }).notNull(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  entryType: text("entry_type").notNull(), // SALE | SALE_UNALLOCATED | REFUND | DISPUTE | DISPUTE_REVERSAL | STRIPE_FEE | PAYOUT | PAYOUT_PAID | PAYOUT_REVERSAL | STRIPE_OTHER | ORGANISER_PAYMENT | ADJUSTMENT | EVENT_FEE | REVERSAL
  entryDate: date("entry_date").notNull(), // posting date (drives accounting periods)
  sourceDate: timestamp("source_date", { withTimezone: true }).notNull(), // when it happened at the source (e.g. Stripe created)
  currency: text("currency").notNull(),
  description: text("description").notNull(),
  reference: text("reference"),
  eventId: uuid("event_id").references(() => acctEvents.id),
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  stripeAccountRef: uuid("stripe_account_ref").references(() => stripeAccounts.id),
  stripeBalanceTransactionId: text("stripe_balance_transaction_id"),
  sourceType: text("source_type"), // stripe_balance_transaction | stripe_payout | organiser_payment | adjustment | event_fee | reversal
  sourceId: text("source_id"),
  agreementId: uuid("agreement_id").references(() => acctAgreements.id),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("POSTED"), // POSTED | REVERSED
  reversesEntryId: uuid("reverses_entry_id"),
  reversedByEntryId: uuid("reversed_by_entry_id"),
  reason: text("reason"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("acct_journal_entries_idem_uq").on(t.organisationId, t.idempotencyKey),
  uniqueIndex("acct_journal_entries_seq_uq").on(t.seq),
  index("acct_journal_entries_org_date_idx").on(t.organisationId, t.livemode, t.entryDate),
  index("acct_journal_entries_event_idx").on(t.eventId),
  index("acct_journal_entries_organiser_idx").on(t.organiserId),
  index("acct_journal_entries_bt_idx").on(t.stripeBalanceTransactionId),
]);

export const acctJournalLines = pgTable("acct_journal_lines", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entryId: uuid("entry_id").notNull().references(() => acctJournalEntries.id),
  organisationId: org(),
  accountId: uuid("account_id").notNull().references(() => acctAccounts.id),
  debit: money("debit").notNull().default(0),
  credit: money("credit").notNull().default(0),
  eventId: uuid("event_id").references(() => acctEvents.id),
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  memo: text("memo"),
}, (t) => [
  index("acct_journal_lines_entry_idx").on(t.entryId),
  index("acct_journal_lines_account_idx").on(t.accountId),
  index("acct_journal_lines_event_idx").on(t.eventId),
  index("acct_journal_lines_organiser_idx").on(t.organiserId),
  check("acct_journal_lines_amount_ck", sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0 or ${t.credit} = 0) and ${t.debit} + ${t.credit} > 0`),
]);

export const acctOrganiserPayments = pgTable("acct_organiser_payments", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  organiserId: uuid("organiser_id").notNull().references(() => acctOrganisers.id),
  eventId: uuid("event_id").references(() => acctEvents.id),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  paymentDate: date("payment_date").notNull(),
  bankReference: text("bank_reference"),
  method: text("method").notNull().default("BANK_TRANSFER"), // BANK_TRANSFER | STRIPE_TRANSFER | CASH | OTHER
  notes: text("notes"),
  status: text("status").notNull().default("PAID"), // PENDING | PAID | VOIDED
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  voidEntryId: uuid("void_entry_id").references(() => acctJournalEntries.id),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_organiser_payments_org_idx").on(t.organisationId, t.livemode, t.paymentDate.desc()),
  index("acct_organiser_payments_organiser_idx").on(t.organiserId),
  check("acct_organiser_payments_amount_ck", sql`${t.amount} > 0`),
]);

/** Every manual (re)assignment of a Stripe transaction, kept forever. */
export const acctMatchHistory = pgTable("acct_match_history", {
  id: id(),
  organisationId: org(),
  balanceTransactionRef: uuid("balance_transaction_ref").notNull().references(() => stripeBalanceTransactions.id),
  action: text("action").notNull(), // MATCH | UNMATCH | CLASSIFY | AUTO_MATCH
  fromEventId: uuid("from_event_id"), toEventId: uuid("to_event_id"),
  fromOrganiserId: uuid("from_organiser_id"), toOrganiserId: uuid("to_organiser_id"),
  fromStatus: text("from_status"), toStatus: text("to_status"),
  reason: text("reason"),
  userId: uuid("user_id").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index("acct_match_history_bt_idx").on(t.balanceTransactionRef)]);

// ---------- sync ----------
export const acctSyncRuns = pgTable("acct_sync_runs", {
  id: id(),
  organisationId: org(),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  kind: text("kind").notNull(), // RECENT | RANGE | FULL | RETRY | RECONCILE | SCHEDULED
  rangeFrom: timestamp("range_from", { withTimezone: true }),
  rangeTo: timestamp("range_to", { withTimezone: true }),
  status: text("status").notNull().default("QUEUED"), // QUEUED | RUNNING | SUCCEEDED | PARTIAL | FAILED
  cursor: text("cursor"), // last processed balance transaction id (resume point)
  discovered: integer("discovered").notNull().default(0),
  imported: integer("imported").notNull().default(0),
  existing: integer("existing").notNull().default(0),
  newlyMatched: integer("newly_matched").notNull().default(0),
  unmatched: integer("unmatched").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  summary: jsonb("summary").notNull().default({}),
  error: text("error"),
  requestedBy: uuid("requested_by").references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("acct_sync_runs_org_idx").on(t.organisationId, t.livemode, t.createdAt.desc())]);

export const acctSyncErrors = pgTable("acct_sync_errors", {
  id: id(),
  organisationId: org(),
  runId: uuid("run_id").references(() => acctSyncRuns.id),
  stripeAccountRef: uuid("stripe_account_ref").notNull().references(() => stripeAccounts.id),
  livemode: boolean("livemode").notNull(),
  objectId: text("object_id"), // txn_… / po_… / evt_…
  stage: text("stage").notNull(), // fetch | import | payout | webhook
  message: text("message").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("acct_sync_errors_org_idx").on(t.organisationId, t.livemode, t.resolvedAt)]);
