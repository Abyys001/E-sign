import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, bigserial, bigint, date, check } from "drizzle-orm/pg-core";
import { contracts, organisations, storageObjects, users } from "./schema";

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
  reportingCurrency: text("reporting_currency"), // optional currency for converted (indicative) global totals
  fxRates: jsonb("fx_rates").notNull().default({}),
  invoiceSettings: jsonb("invoice_settings").notNull().default({}),
  bookingFeeRefundable: boolean("booking_fee_refundable").notNull().default(false),
  xeSettings: jsonb("xe_settings").notNull().default({}), // { accountId, apiKeyEnc, keyHint, lastRates, lastAt, lastError } — XE Currency Data API
  monitorSettings: jsonb("monitor_settings").notNull().default({}), // thresholds for coded checks + forecast assumptions (server/accounting/monitor.ts); {} = defaults
  payoutSettings: jsonb("payout_settings").notNull().default({}), // { live|test: { keyEnc, keyHint, financialAccountId, … } } — Stripe Global Payouts (server/accounting/stripe-payouts.ts)
  paymentLinkSettings: jsonb("payment_link_settings").notNull().default({}), // { live|test: { keyEnc, keyHint, lastTestedAt, lastError } } — key that creates Checkout Sessions for payment links (server/accounting/payment-links.ts)
  treasurySettings: jsonb("treasury_settings").notNull().default({}), // { live|test: { keyEnc, keyHint, financialAccountId } } — Stripe Treasury/Issuing (server/treasury/stripe.ts)
  aiSettings: jsonb("ai_settings").notNull().default({}), // { enabled, model, apiKeyEnc, keyHint, instructions } — the key is encrypted, never returned // platform policy: refunds never reduce Bilit's booking fee // seller details + VAT treatment for customer invoices // { eur: "0.85", usd: "0.74" } = 1 unit of key in the reporting currency; reporting only, never posted
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
  stripeRecipientId: text("stripe_recipient_id"), // Stripe Global Payouts recipient (acct_…) used by "Send money"
  cashbackBps: integer("cashback_bps").notNull().default(0), // cashback on finished events, % × 100 of ticket sales after refunds excl. booking fees (server/accounting/cashback.ts)
  cashbackFrom: date("cashback_from"), // only events on/after this date (null = all)
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
  outcome: jsonb("outcome"), // { networkStatus, type, reason, riskLevel, riskScore, sellerMessage }
  paymentMethod: jsonb("payment_method"), // { type, brand, last4, country, funding, wallet, expMonth, expYear }
  receiptUrl: text("receipt_url"),
  billingAddress: jsonb("billing_address"),
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
  failureReason: text("failure_reason"),
  keepBookingFee: boolean("keep_booking_fee").notNull().default(false), // refund of the ticket price only: Bilit keeps its booking fee
  requestedBy: uuid("requested_by").references(() => users.id), // set when the refund was issued from this app
  note: text("note"),
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
  sourceType: text("source_type"), // stripe_balance_transaction | stripe_payout | organiser_payment | adjustment | event_fee | reversal | ticket_import | manual_sale
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
  revision: integer("revision").notNull().default(0), // bumped on each edit that re-posts the payment (reversal + new entry)
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  voidEntryId: uuid("void_entry_id").references(() => acctJournalEntries.id),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  /** proof of payment (e.g. the Wise transfer confirmation PDF); several records of one split payment share it */
  proofObjectId: uuid("proof_object_id").references(() => storageObjects.id),
  proofName: text("proof_name"),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_organiser_payments_org_idx").on(t.organisationId, t.livemode, t.paymentDate.desc()),
  index("acct_organiser_payments_organiser_idx").on(t.organiserId),
  check("acct_organiser_payments_amount_ck", sql`${t.amount} > 0`),
]);

/**
 * Manually entered event cost (venue, artist, marketing…). Borne by Bilit (reduces Bilit profit) or by the organiser
 * (deducted from the amount due to them). Posted to the ledger like a payment; edits re-post, deleting voids.
 */
export const acctEventExpenses = pgTable("acct_event_expenses", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  eventId: uuid("event_id").notNull().references(() => acctEvents.id),
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  name: text("name").notNull(),
  category: text("category").notNull(), // VENUE | ARTIST | MARKETING | SECURITY | PRODUCTION | STAFF | TRANSPORT | ACCOMMODATION | OTHER
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  expenseDate: date("expense_date").notNull(),
  description: text("description"),
  borneBy: text("borne_by").notNull().default("BILIT"), // BILIT | ORGANISER
  receiptObjectId: uuid("receipt_object_id").references(() => storageObjects.id),
  receiptName: text("receipt_name"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | VOIDED
  revision: integer("revision").notNull().default(0),
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_event_expenses_event_idx").on(t.eventId, t.expenseDate.desc()),
  index("acct_event_expenses_org_idx").on(t.organisationId, t.livemode, t.expenseDate.desc()),
  check("acct_event_expenses_amount_ck", sql`${t.amount} > 0`),
]);

/** Users who may see one organiser's own figures (organiser portal). Read-only; never grants accounting.view. */
export const acctOrganiserUsers = pgTable("acct_organiser_users", {
  organiserId: uuid("organiser_id").notNull().references(() => acctOrganisers.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  organisationId: org(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("acct_organiser_users_uq").on(t.organiserId, t.userId), index("acct_organiser_users_user_idx").on(t.userId)]);

/** A signed (or in-progress) contract linked to an organiser, optionally for one event (e.g. an Event Schedule). */
export const acctOrganiserContracts = pgTable("acct_organiser_contracts", {
  id: id(),
  organisationId: org(),
  organiserId: uuid("organiser_id").notNull().references(() => acctOrganisers.id),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  eventId: uuid("event_id").references(() => acctEvents.id),
  role: text("role").notNull().default("OTHER"), // MASTER | EVENT_SCHEDULE | OTHER
  note: text("note"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("acct_organiser_contracts_uq").on(t.organiserId, t.contractId), index("acct_organiser_contracts_event_idx").on(t.eventId), index("acct_organiser_contracts_contract_idx").on(t.contractId)]);

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

// ---------- bookkeeping: supplier invoices, expenses, employees, payslips ----------
/**
 * A supplier invoice (BILL: owed until paid) or a manual expense (EXPENSE: paid when recorded). Net + VAT = total,
 * in the document's own currency. Posted to the ledger; edits re-post, deleting voids.
 */
export const acctBills = pgTable("acct_bills", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  kind: text("kind").notNull(), // BILL | EXPENSE
  supplierName: text("supplier_name").notNull(),
  supplierVat: text("supplier_vat"),
  country: text("country"), // ISO 3166 alpha-2
  invoiceNumber: text("invoice_number"),
  invoiceDate: date("invoice_date").notNull(),
  dueDate: date("due_date"),
  currency: text("currency").notNull(),
  netAmount: money("net_amount").notNull(),
  vatAmount: money("vat_amount").notNull().default(0),
  totalAmount: money("total_amount").notNull(),
  accountId: uuid("account_id").notNull().references(() => acctAccounts.id), // expense account (category)
  eventId: uuid("event_id").references(() => acctEvents.id),
  description: text("description"),
  paidFrom: text("paid_from"), // BANK | CASH | CARD | EMPLOYEE (expenses, and how a bill was paid)
  status: text("status").notNull(), // UNPAID | PAID | VOIDED
  paidDate: date("paid_date"),
  paymentReference: text("payment_reference"),
  fileObjectId: uuid("file_object_id").references(() => storageObjects.id),
  fileName: text("file_name"),
  revision: integer("revision").notNull().default(0),
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  paymentEntryId: uuid("payment_entry_id").references(() => acctJournalEntries.id),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_bills_org_idx").on(t.organisationId, t.livemode, t.invoiceDate.desc()),
  index("acct_bills_status_idx").on(t.organisationId, t.livemode, t.status),
  check("acct_bills_amounts_ck", sql`${t.netAmount} >= 0 and ${t.vatAmount} >= 0 and ${t.totalAmount} = ${t.netAmount} + ${t.vatAmount} and ${t.totalAmount} > 0`),
]);

export const acctEmployees = pgTable("acct_employees", {
  id: id(),
  organisationId: org(),
  name: text("name").notNull(),
  email: text("email"),
  jobTitle: text("job_title"),
  employeeRef: text("employee_ref"),
  country: text("country").notNull(), // ISO 3166 alpha-2; drives labels and the tax year
  currency: text("currency").notNull(),
  taxId: text("tax_id"), // tax code / Steuer-ID / TIN
  socialSecurityNo: text("social_security_no"), // NI number / SV-Nummer
  address: text("address"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  payFrequency: text("pay_frequency").notNull().default("MONTHLY"), // MONTHLY | FOUR_WEEKLY | FORTNIGHTLY | WEEKLY
  defaultGross: money("default_gross"),
  bankDetailsEnc: text("bank_details_enc"),
  bankHint: text("bank_hint"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("acct_employees_org_idx").on(t.organisationId, t.name)]);

/** Payslip. Deductions are entered by hand; net = gross − deductions. FINAL payslips are immutable (void + reissue). */
export const acctPayslips = pgTable("acct_payslips", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  employeeId: uuid("employee_id").notNull().references(() => acctEmployees.id),
  number: text("number"), // assigned when finalised, e.g. PS-2026-0001
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payDate: date("pay_date").notNull(),
  currency: text("currency").notNull(),
  earnings: jsonb("earnings").notNull().default([]), // [{ label, amount }]
  deductions: jsonb("deductions").notNull().default([]), // [{ label, type: TAX|SOCIAL|PENSION|OTHER, amount }]
  employerCosts: jsonb("employer_costs").notNull().default([]), // [{ label, amount }] (employer NI / social / pension)
  grossPay: money("gross_pay").notNull(),
  totalDeductions: money("total_deductions").notNull(),
  netPay: money("net_pay").notNull(),
  employerTotal: money("employer_total").notNull().default(0),
  notes: text("notes"),
  status: text("status").notNull().default("DRAFT"), // DRAFT | FINAL | PAID | VOIDED
  pdfObjectId: uuid("pdf_object_id").references(() => storageObjects.id),
  pdfSha256: text("pdf_sha256"),
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  paymentEntryId: uuid("payment_entry_id").references(() => acctJournalEntries.id),
  paidDate: date("paid_date"),
  paymentReference: text("payment_reference"),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  finalisedBy: uuid("finalised_by").references(() => users.id),
  finalisedAt: timestamp("finalised_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_payslips_employee_idx").on(t.employeeId, t.payDate.desc()),
  index("acct_payslips_org_idx").on(t.organisationId, t.livemode, t.payDate.desc()),
  uniqueIndex("acct_payslips_number_uq").on(t.organisationId, t.number).where(sql`${t.number} is not null`),
  check("acct_payslips_net_ck", sql`${t.netPay} = ${t.grossPay} - ${t.totalDeductions}`),
]);

/**
 * Customer invoice (for a ticket sale) or credit note (for a refund), generated from the Stripe transaction. Numbered,
 * rendered once to PDF and stored; never edited (void + reissue). A VAT invoice carries the customer's business details.
 */
export const acctCustomerInvoices = pgTable("acct_customer_invoices", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  kind: text("kind").notNull(), // INVOICE | CREDIT_NOTE
  number: text("number").notNull(),
  vatInvoice: boolean("vat_invoice").notNull().default(false),
  balanceTransactionRef: uuid("balance_transaction_ref").notNull().references(() => stripeBalanceTransactions.id),
  chargeId: text("charge_id"),
  eventId: uuid("event_id").references(() => acctEvents.id),
  relatedInvoiceId: uuid("related_invoice_id"), // credit note → the invoice it corrects
  issueDate: date("issue_date").notNull(),
  supplyDate: date("supply_date"),
  currency: text("currency").notNull(),
  seller: jsonb("seller").notNull(), // snapshot of the issuer details at issue time
  customer: jsonb("customer").notNull(), // { name, email, company, address, vatNumber, country }
  lines: jsonb("lines").notNull(), // [{ description, quantity, net, vatRateBps, vat, gross, note }]
  netTotal: money("net_total").notNull(),
  vatTotal: money("vat_total").notNull(),
  grossTotal: money("gross_total").notNull(),
  status: text("status").notNull().default("ISSUED"), // ISSUED | VOIDED
  pdfObjectId: uuid("pdf_object_id").references(() => storageObjects.id),
  pdfSha256: text("pdf_sha256"),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("acct_customer_invoices_number_uq").on(t.organisationId, t.number),
  index("acct_customer_invoices_bt_idx").on(t.balanceTransactionRef),
  index("acct_customer_invoices_org_idx").on(t.organisationId, t.livemode, t.issueDate.desc()),
  check("acct_customer_invoices_totals_ck", sql`${t.grossTotal} = ${t.netTotal} + ${t.vatTotal}`),
]);

/** AI bookkeeping reviews (OpenAI): what was asked about, the model's structured findings, and who ran it. */
export const acctAiReviews = pgTable("acct_ai_reviews", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  rangeFrom: date("range_from").notNull(),
  rangeTo: date("range_to").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(), // SUCCEEDED | FAILED
  result: jsonb("result"), // { summary, overallStatus, findings[], questionsForAccountant[], goodPractice[] }
  error: text("error"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index("acct_ai_reviews_org_idx").on(t.organisationId, t.createdAt.desc())]);

// ---------- Wise (bank feed) ----------
/** Read-only Wise API connection (one per organisation). Token and SCA private key are encrypted; never returned. */
export const acctWiseConnections = pgTable("acct_wise_connections", {
  id: id(),
  organisationId: org(),
  tokenEnc: text("token_enc").notNull(),
  tokenHint: text("token_hint"),
  profileId: text("profile_id"),
  profileName: text("profile_name"),
  scaPrivateKeyEnc: text("sca_private_key_enc"),
  scaPublicKey: text("sca_public_key"), // PEM the admin uploads to Wise so balance statements can be read
  balances: jsonb("balances").notNull().default([]), // [{ id, currency, amount (minor) }]
  status: text("status").notNull().default("CONNECTED"), // CONNECTED | ERROR
  statementsOk: boolean("statements_ok").notNull().default(false),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("acct_wise_connections_org_uq").on(t.organisationId)]);

/** Wise money movements: outgoing transfers (transfers API) and balance-statement lines (deposits, conversions, fees…). */
export const acctWiseTransactions = pgTable("acct_wise_transactions", {
  id: id(),
  organisationId: org(),
  wiseId: text("wise_id").notNull(), // "TRANSFER-123" for transfers (same key the statement uses), else the statement reference number
  source: text("source").notNull(), // TRANSFER | STATEMENT
  direction: text("direction").notNull(), // OUT | IN
  kind: text("kind").notNull(), // TRANSFER | DEPOSIT | CONVERSION | CARD | FEE | OTHER
  status: text("status"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  amount: money("amount").notNull(), // positive, minor units; for transfers the amount the recipient receives
  currency: text("currency").notNull(),
  sourceAmount: money("source_amount"), sourceCurrency: text("source_currency"),
  fee: money("fee"),
  counterparty: text("counterparty"),
  reference: text("reference"),
  description: text("description"),
  raw: jsonb("raw"),
  organiserPaymentId: uuid("organiser_payment_id").references(() => acctOrganiserPayments.id),
  suggestedOrganiserId: uuid("suggested_organiser_id").references(() => acctOrganisers.id),
  stripePayoutId: text("stripe_payout_id"), // incoming money matched to a Stripe payout
  billId: uuid("bill_id").references(() => acctBills.id), // booked as a supplier invoice / expense
  partnerPaymentId: uuid("partner_payment_id").references(() => acctPartnerPayments.id), // paid to a profit-share partner
  ignored: boolean("ignored").notNull().default(false),
  ignoredReason: text("ignored_reason"),
  ignoredBy: uuid("ignored_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("acct_wise_transactions_uq").on(t.organisationId, t.wiseId), index("acct_wise_transactions_date_idx").on(t.organisationId, t.occurredAt)]);

// ---------- profit share ----------
/** A person/company entitled to a share of each event's Bilit profit (e.g. the web developer: 10%). */
export const acctProfitPartners = pgTable("acct_profit_partners", {
  id: id(),
  organisationId: org(),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  shareBps: integer("share_bps").notNull(), // 1000 = 10%
  appliesFrom: date("applies_from"), // events starting on/after this date; null = all events
  lossesCount: boolean("losses_count").notNull().default(false), // false: an event with a loss gives a 0 share
  stripeRecipientId: text("stripe_recipient_id"), // Stripe Global Payouts recipient (acct_…) used by "Send money"
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("acct_profit_partners_org_idx").on(t.organisationId), check("acct_profit_partners_bps_ck", sql`${t.shareBps} >= 0 and ${t.shareBps} <= 10000`)]);

/** Money Bilit paid a profit-share partner; reduces Profit Share Payable via its own ledger entry. */
export const acctPartnerPayments = pgTable("acct_partner_payments", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  partnerId: uuid("partner_id").notNull().references(() => acctProfitPartners.id),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  paymentDate: date("payment_date").notNull(),
  method: text("method").notNull().default("BANK_TRANSFER"),
  bankReference: text("bank_reference"),
  notes: text("notes"),
  status: text("status").notNull().default("PAID"), // PAID | VOIDED
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  voidEntryId: uuid("void_entry_id").references(() => acctJournalEntries.id),
  voidReason: text("void_reason"),
  voidedBy: uuid("voided_by").references(() => users.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index("acct_partner_payments_partner_idx").on(t.partnerId, t.paymentDate), check("acct_partner_payments_amount_ck", sql`${t.amount} > 0`)]);

// ---------- Stripe Global Payouts ----------
/**
 * Money sent from Bilit's Stripe financial account with the OutboundPayments v2 API. The matching book entry (organiser
 * payment / partner payment / bill paid) is created when Stripe accepts the payment and voided if Stripe reports it
 * failed, returned or cancelled. status: SENDING (request in flight / outcome unknown) | PROCESSING | POSTED | FAILED |
 * RETURNED | CANCELED | REJECTED (Stripe refused the request; nothing was sent).
 */
export const acctStripeOutbound = pgTable("acct_stripe_outbound", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  payeeType: text("payee_type").notNull(), // ORGANISER | PARTNER | BILL
  organiserId: uuid("organiser_id").references(() => acctOrganisers.id),
  eventId: uuid("event_id").references(() => acctEvents.id),
  partnerId: uuid("partner_id").references(() => acctProfitPartners.id),
  billId: uuid("bill_id").references(() => acctBills.id),
  payeeName: text("payee_name").notNull(),
  recipientId: text("recipient_id").notNull(),
  payoutMethodId: text("payout_method_id"),
  payoutMethodLabel: text("payout_method_label"),
  financialAccountId: text("financial_account_id").notNull(),
  amount: money("amount").notNull(), // debited from the financial account, minor units of `currency`
  currency: text("currency").notNull(),
  toCurrency: text("to_currency"),
  creditedAmount: money("credited_amount"),
  feeAmount: money("fee_amount").notNull().default(0), // Stripe's estimated fees from the quote (shown before sending; not posted to the ledger)
  description: text("description"),
  statementDescriptor: text("statement_descriptor"),
  quoteId: text("quote_id"),
  verificationId: text("verification_id"),
  verificationResult: text("verification_result"),
  stripeId: text("stripe_id"),
  status: text("status").notNull(),
  stripeStatus: text("stripe_status"),
  failure: text("failure"),
  organiserPaymentId: uuid("organiser_payment_id").references(() => acctOrganiserPayments.id),
  partnerPaymentId: uuid("partner_payment_id").references(() => acctPartnerPayments.id),
  raw: jsonb("raw"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("acct_stripe_outbound_org_idx").on(t.organisationId, t.livemode, t.createdAt.desc()),
  uniqueIndex("acct_stripe_outbound_stripe_uq").on(t.stripeId).where(sql`${t.stripeId} is not null`),
  check("acct_stripe_outbound_amount_ck", sql`${t.amount} > 0`),
]);

// ---------- payment links ----------
/** A branded public page (/pay/<slug>) for one event + price; paying opens a Stripe Checkout Session (server/accounting/payment-links.ts). */
export const acctPaymentLinks = pgTable("acct_payment_links", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  slug: text("slug").notNull(),
  kind: text("kind").notNull().default("EVENT"), // EVENT (ticket for an event) | CUSTOM (any payment, no event)
  eventId: uuid("event_id").references(() => acctEvents.id),
  eventName: text("event_name").notNull(),
  eventCode: text("event_code"), // put in the Stripe description + metadata so the importer matches the sale to the event
  title: text("title").notNull(), // what is bought, e.g. "General admission"
  description: text("description"),
  venue: text("venue"),
  eventDate: date("event_date"),
  amount: money("amount").notNull(), // price per item, minor units (with open_amount: the suggested amount)
  openAmount: boolean("open_amount").notNull().default(false), // payer types the amount, between min and max
  minAmount: money("min_amount"),
  maxAmount: money("max_amount"),
  currency: text("currency").notNull(),
  feeBps: integer("fee_bps").notNull().default(0), // booking fee ADDED on top of the price, as its own checkout line
  adjustableQuantity: boolean("adjustable_quantity").notNull().default(true),
  maxQuantity: integer("max_quantity").notNull().default(10),
  branding: jsonb("branding").notNull().default({}), // { displayName, accentColor, backgroundColor, fontFamily, borderStyle, imageUrl }
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | DISABLED
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("acct_payment_links_slug_uq").on(t.slug),
  index("acct_payment_links_org_idx").on(t.organisationId, t.livemode, t.createdAt.desc()),
  check("acct_payment_links_amount_ck", sql`${t.amount} > 0`),
  check("acct_payment_links_fee_ck", sql`${t.feeBps} >= 0 and ${t.feeBps} <= 5000`),
  check("acct_payment_links_qty_ck", sql`${t.maxQuantity} >= 1 and ${t.maxQuantity} <= 99`),
]);

export const acctPaymentLinkSessions = pgTable("acct_payment_link_sessions", {
  id: id(),
  linkId: uuid("link_id").notNull().references(() => acctPaymentLinks.id),
  sessionId: text("session_id").notNull(), // cs_…
  quantity: integer("quantity").notNull(),
  amountTotal: money("amount_total").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("OPEN"), // OPEN | PAID | EXPIRED
  customerEmail: text("customer_email"),
  customerName: text("customer_name"),
  paymentIntentId: text("payment_intent_id"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("acct_payment_link_sessions_uq").on(t.sessionId),
  index("acct_payment_link_sessions_link_idx").on(t.linkId, t.createdAt.desc()),
]);

// Ticket-system CSV export for one event (order, ticket type, ticket price, booking fee, add-ons). APPLIED imports true up
// the booked booking fee to what customers were really charged; a newer applied import supersedes the older one.
export const acctTicketImports = pgTable("acct_ticket_imports", {
  id: id(),
  organisationId: org(),
  livemode: boolean("livemode").notNull(),
  eventId: uuid("event_id").notNull().references(() => acctEvents.id),
  fileName: text("file_name"),
  status: text("status").notNull().default("PREVIEW"), // PREVIEW | APPLIED | SUPERSEDED
  summary: jsonb("summary").notNull(),
  orders: jsonb("orders").notNull(),
  appliedAmount: money("applied_amount"), // cumulative booking-fee correction booked for the event once this import is applied
  journalEntryId: uuid("journal_entry_id").references(() => acctJournalEntries.id),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedBy: uuid("applied_by").references(() => users.id),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [index("acct_ticket_imports_event_idx").on(t.organisationId, t.eventId, t.createdAt)]);

/**
 * A phone enrolled for the AI Accountant phone app (/phone). Enrolment needs a full sign-in plus re-authentication;
 * the phone then keeps a long-lived device token (httpOnly cookie) and unlocks with a PIN into a short call-only
 * session. Only hashes are stored. Too many wrong PINs revoke the device (a full sign-in is needed to enrol again).
 */
export const acctPhoneDevices = pgTable("acct_phone_devices", {
  id: id(),
  organisationId: org(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  pinHash: text("pin_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  sessionHash: text("session_hash"),
  sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastUnlockAt: timestamp("last_unlock_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("acct_phone_devices_token_uq").on(t.tokenHash), index("acct_phone_devices_user_idx").on(t.organisationId, t.userId)]);

/** One-time QR pairing code: a signed-in, re-authenticated user shows it on screen; the phone scans it to enrol. */
export const acctPhonePairings = pgTable("acct_phone_pairings", {
  id: id(),
  organisationId: org(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  deviceId: uuid("device_id").references(() => acctPhoneDevices.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("acct_phone_pairings_code_uq").on(t.codeHash)]);

/**
 * Telegram finance assistant: a Telegram account linked to a Bilit user (paired with a one-time code from Settings).
 * Only linked, non-revoked accounts are served; the Bilit user's finance permissions apply to everything they ask.
 */
export const acctTelegramUsers = pgTable("acct_telegram_users", {
  id: id(),
  organisationId: org(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  username: text("username"),
  voiceReplies: boolean("voice_replies"), // null = organisation default
  language: text("language"), // null = auto
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [uniqueIndex("acct_telegram_users_tg_uq").on(t.organisationId, t.telegramUserId)]);

/** One-time pairing code ("/link CODE"), shown in Settings to a re-authenticated user; only its hash is stored. */
export const acctTelegramPairings = pgTable("acct_telegram_pairings", {
  id: id(),
  organisationId: org(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("acct_telegram_pairings_code_uq").on(t.codeHash)]);

/** Conversation + workflow state per Telegram account: recent messages, proposals waiting for "yes", an uploaded document. */
export const acctTelegramSessions = pgTable("acct_telegram_sessions", {
  id: id(),
  organisationId: org(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  messages: jsonb("messages").notNull().default(sql`'[]'::jsonb`),
  pending: jsonb("pending").notNull().default(sql`'{}'::jsonb`),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("acct_telegram_sessions_uq").on(t.organisationId, t.telegramUserId)]);

/** Telegram update ids already handled — Telegram re-sends on timeouts; a retry must never act twice. */
export const acctTelegramUpdates = pgTable("acct_telegram_updates", {
  id: id(),
  organisationId: org(),
  updateId: bigint("update_id", { mode: "number" }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("acct_telegram_updates_uq").on(t.organisationId, t.updateId)]);
