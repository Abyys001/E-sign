-- Accounting & Stripe finance (finance module). Tables generated from src/db/accounting-schema.ts; integrity triggers below.
CREATE TABLE "acct_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"system_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"percent_bps" integer DEFAULT 0 NOT NULL,
	"percent_basis" text DEFAULT 'GROSS' NOT NULL,
	"fixed_per_ticket" bigint DEFAULT 0 NOT NULL,
	"fixed_event_fee" bigint DEFAULT 0 NOT NULL,
	"stripe_fees_borne_by" text DEFAULT 'ORGANISER' NOT NULL,
	"chargebacks_borne_by" text DEFAULT 'ORGANISER' NOT NULL,
	"refunds_reverse_commission" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acct_agreements_bps_ck" CHECK ("acct_agreements"."percent_bps" between 0 and 10000),
	CONSTRAINT "acct_agreements_fixed_ck" CHECK ("acct_agreements"."fixed_per_ticket" >= 0 and "acct_agreements"."fixed_event_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "acct_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"organiser_id" uuid,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"currency" text NOT NULL,
	"starts_on" date,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"current_agreement_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"organisation_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"entry_type" text NOT NULL,
	"entry_date" date NOT NULL,
	"source_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"event_id" uuid,
	"organiser_id" uuid,
	"stripe_account_ref" uuid,
	"stripe_balance_transaction_id" text,
	"source_type" text,
	"source_id" text,
	"agreement_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"reverses_entry_id" uuid,
	"reversed_by_entry_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_journal_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"event_id" uuid,
	"organiser_id" uuid,
	"memo" text,
	CONSTRAINT "acct_journal_lines_amount_ck" CHECK ("acct_journal_lines"."debit" >= 0 and "acct_journal_lines"."credit" >= 0 and ("acct_journal_lines"."debit" = 0 or "acct_journal_lines"."credit" = 0) and "acct_journal_lines"."debit" + "acct_journal_lines"."credit" > 0)
);
--> statement-breakpoint
CREATE TABLE "acct_match_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"balance_transaction_ref" uuid NOT NULL,
	"action" text NOT NULL,
	"from_event_id" uuid,
	"to_event_id" uuid,
	"from_organiser_id" uuid,
	"to_organiser_id" uuid,
	"from_status" text,
	"to_status" text,
	"reason" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_organiser_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"organiser_id" uuid NOT NULL,
	"event_id" uuid,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"payment_date" date NOT NULL,
	"bank_reference" text,
	"method" text DEFAULT 'BANK_TRANSFER' NOT NULL,
	"notes" text,
	"status" text DEFAULT 'PAID' NOT NULL,
	"journal_entry_id" uuid,
	"void_entry_id" uuid,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acct_organiser_payments_amount_ck" CHECK ("acct_organiser_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "acct_organisers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"company_name" text,
	"vat_number" text,
	"address" text,
	"internal_ref" text,
	"bank_details_enc" text,
	"bank_hint" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"base_currency" text DEFAULT 'eur' NOT NULL,
	"default_mode" text DEFAULT 'test' NOT NULL,
	"match_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ticket_quantity_key" text DEFAULT 'quantity' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_sync_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"run_id" uuid,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"object_id" text,
	"stage" text NOT NULL,
	"message" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acct_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"kind" text NOT NULL,
	"range_from" timestamp with time zone,
	"range_to" timestamp with time zone,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"cursor" text,
	"discovered" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"existing" integer DEFAULT 0 NOT NULL,
	"newly_matched" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_account_id" text,
	"display_name" text,
	"secret_key_enc" text,
	"key_hint" text,
	"webhook_secret_enc" text,
	"webhook_secret_hint" text,
	"webhook_endpoint_id" text,
	"status" text DEFAULT 'DISCONNECTED' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"last_webhook_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_balance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"balance_transaction_id" text NOT NULL,
	"type" text NOT NULL,
	"reporting_category" text,
	"source_id" text,
	"amount" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"net" bigint NOT NULL,
	"currency" text NOT NULL,
	"exchange_rate" text,
	"fee_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"stripe_status" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"available_on" timestamp with time zone,
	"charge_id" text,
	"payout_id" text,
	"kind" text NOT NULL,
	"event_code" text,
	"event_id" uuid,
	"organiser_id" uuid,
	"agreement_id" uuid,
	"match_status" text NOT NULL,
	"match_reason" text,
	"match_method" text,
	"reconciliation_status" text NOT NULL,
	"reconciliation_note" text,
	"classification_account_id" uuid,
	"ticket_quantity" integer,
	"commission_amount" bigint,
	"organiser_amount" bigint,
	"posted_entry_id" uuid,
	"posting_version" integer DEFAULT 0 NOT NULL,
	"matched_by" uuid,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"charge_id" text NOT NULL,
	"payment_intent_id" text,
	"balance_transaction_id" text,
	"amount" bigint NOT NULL,
	"amount_captured" bigint DEFAULT 0 NOT NULL,
	"amount_refunded" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"refunded" boolean DEFAULT false NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"description" text,
	"statement_descriptor" text,
	"customer_id" text,
	"customer_name" text,
	"customer_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"dispute_id" text NOT NULL,
	"charge_id" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"event_id" uuid,
	"organiser_id" uuid,
	"accounting_status" text DEFAULT 'OPEN' NOT NULL,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"object_id" text,
	"api_version" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stripe_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"payout_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"automatic" boolean DEFAULT true NOT NULL,
	"method" text,
	"description" text,
	"statement_descriptor" text,
	"balance_transaction_id" text,
	"failure_balance_transaction_id" text,
	"failure_code" text,
	"failure_message" text,
	"arrival_date" timestamp with time zone,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"included_count" integer,
	"included_net" bigint,
	"reconciliation_status" text DEFAULT 'UNMATCHED' NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_account_ref" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"refund_id" text NOT NULL,
	"charge_id" text,
	"payment_intent_id" text,
	"balance_transaction_id" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text,
	"reason" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acct_accounts" ADD CONSTRAINT "acct_accounts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_agreements" ADD CONSTRAINT "acct_agreements_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_agreements" ADD CONSTRAINT "acct_agreements_event_id_acct_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."acct_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_agreements" ADD CONSTRAINT "acct_agreements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_events" ADD CONSTRAINT "acct_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_events" ADD CONSTRAINT "acct_events_organiser_id_acct_organisers_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."acct_organisers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_events" ADD CONSTRAINT "acct_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_event_id_acct_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."acct_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_organiser_id_acct_organisers_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."acct_organisers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_agreement_id_acct_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."acct_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_lines" ADD CONSTRAINT "acct_journal_lines_entry_id_acct_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."acct_journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_lines" ADD CONSTRAINT "acct_journal_lines_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_lines" ADD CONSTRAINT "acct_journal_lines_account_id_acct_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."acct_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_lines" ADD CONSTRAINT "acct_journal_lines_event_id_acct_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."acct_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_journal_lines" ADD CONSTRAINT "acct_journal_lines_organiser_id_acct_organisers_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."acct_organisers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_match_history" ADD CONSTRAINT "acct_match_history_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_match_history" ADD CONSTRAINT "acct_match_history_balance_transaction_ref_stripe_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_ref") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_match_history" ADD CONSTRAINT "acct_match_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_organiser_id_acct_organisers_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."acct_organisers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_event_id_acct_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."acct_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_journal_entry_id_acct_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."acct_journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_void_entry_id_acct_journal_entries_id_fk" FOREIGN KEY ("void_entry_id") REFERENCES "public"."acct_journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organiser_payments" ADD CONSTRAINT "acct_organiser_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organisers" ADD CONSTRAINT "acct_organisers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_organisers" ADD CONSTRAINT "acct_organisers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_periods" ADD CONSTRAINT "acct_periods_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_periods" ADD CONSTRAINT "acct_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_settings" ADD CONSTRAINT "acct_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_settings" ADD CONSTRAINT "acct_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_sync_errors" ADD CONSTRAINT "acct_sync_errors_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_sync_errors" ADD CONSTRAINT "acct_sync_errors_run_id_acct_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."acct_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_sync_errors" ADD CONSTRAINT "acct_sync_errors_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_sync_runs" ADD CONSTRAINT "acct_sync_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_sync_runs" ADD CONSTRAINT "acct_sync_runs_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acct_sync_runs" ADD CONSTRAINT "acct_sync_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transactions" ADD CONSTRAINT "stripe_balance_transactions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transactions" ADD CONSTRAINT "stripe_balance_transactions_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transactions" ADD CONSTRAINT "stripe_balance_transactions_event_id_acct_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."acct_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transactions" ADD CONSTRAINT "stripe_balance_transactions_organiser_id_acct_organisers_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."acct_organisers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transactions" ADD CONSTRAINT "stripe_balance_transactions_agreement_id_acct_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."acct_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transactions" ADD CONSTRAINT "stripe_balance_transactions_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_charges" ADD CONSTRAINT "stripe_charges_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_charges" ADD CONSTRAINT "stripe_charges_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_disputes" ADD CONSTRAINT "stripe_disputes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_disputes" ADD CONSTRAINT "stripe_disputes_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_disputes" ADD CONSTRAINT "stripe_disputes_event_id_acct_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."acct_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_disputes" ADD CONSTRAINT "stripe_disputes_organiser_id_acct_organisers_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."acct_organisers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payouts" ADD CONSTRAINT "stripe_payouts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payouts" ADD CONSTRAINT "stripe_payouts_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_refunds" ADD CONSTRAINT "stripe_refunds_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_refunds" ADD CONSTRAINT "stripe_refunds_stripe_account_ref_stripe_accounts_id_fk" FOREIGN KEY ("stripe_account_ref") REFERENCES "public"."stripe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acct_accounts_code_uq" ON "acct_accounts" USING btree ("organisation_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_accounts_system_uq" ON "acct_accounts" USING btree ("organisation_id","system_key") WHERE "acct_accounts"."system_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acct_agreements_event_version_uq" ON "acct_agreements" USING btree ("event_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_events_code_uq" ON "acct_events" USING btree ("organisation_id",upper("code"));--> statement-breakpoint
CREATE INDEX "acct_events_organiser_idx" ON "acct_events" USING btree ("organiser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_journal_entries_idem_uq" ON "acct_journal_entries" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_journal_entries_seq_uq" ON "acct_journal_entries" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_org_date_idx" ON "acct_journal_entries" USING btree ("organisation_id","livemode","entry_date");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_event_idx" ON "acct_journal_entries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_organiser_idx" ON "acct_journal_entries" USING btree ("organiser_id");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_bt_idx" ON "acct_journal_entries" USING btree ("stripe_balance_transaction_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_entry_idx" ON "acct_journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_account_idx" ON "acct_journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_event_idx" ON "acct_journal_lines" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_organiser_idx" ON "acct_journal_lines" USING btree ("organiser_id");--> statement-breakpoint
CREATE INDEX "acct_match_history_bt_idx" ON "acct_match_history" USING btree ("balance_transaction_ref");--> statement-breakpoint
CREATE INDEX "acct_organiser_payments_org_idx" ON "acct_organiser_payments" USING btree ("organisation_id","livemode","payment_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "acct_organiser_payments_organiser_idx" ON "acct_organiser_payments" USING btree ("organiser_id");--> statement-breakpoint
CREATE INDEX "acct_organisers_org_idx" ON "acct_organisers" USING btree ("organisation_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_organisers_ref_uq" ON "acct_organisers" USING btree ("organisation_id",lower("internal_ref")) WHERE "acct_organisers"."internal_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acct_periods_uq" ON "acct_periods" USING btree ("organisation_id","period");--> statement-breakpoint
CREATE INDEX "acct_sync_errors_org_idx" ON "acct_sync_errors" USING btree ("organisation_id","livemode","resolved_at");--> statement-breakpoint
CREATE INDEX "acct_sync_runs_org_idx" ON "acct_sync_runs" USING btree ("organisation_id","livemode","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_accounts_org_mode_uq" ON "stripe_accounts" USING btree ("organisation_id","livemode");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_bt_uq" ON "stripe_balance_transactions" USING btree ("stripe_account_ref","balance_transaction_id");--> statement-breakpoint
CREATE INDEX "stripe_bt_org_time_idx" ON "stripe_balance_transactions" USING btree ("organisation_id","livemode","stripe_created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stripe_bt_recon_idx" ON "stripe_balance_transactions" USING btree ("organisation_id","livemode","reconciliation_status");--> statement-breakpoint
CREATE INDEX "stripe_bt_event_idx" ON "stripe_balance_transactions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "stripe_bt_organiser_idx" ON "stripe_balance_transactions" USING btree ("organiser_id");--> statement-breakpoint
CREATE INDEX "stripe_bt_charge_idx" ON "stripe_balance_transactions" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "stripe_bt_payout_idx" ON "stripe_balance_transactions" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "stripe_bt_source_idx" ON "stripe_balance_transactions" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_charges_uq" ON "stripe_charges" USING btree ("stripe_account_ref","charge_id");--> statement-breakpoint
CREATE INDEX "stripe_charges_org_idx" ON "stripe_charges" USING btree ("organisation_id","livemode","stripe_created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stripe_charges_pi_idx" ON "stripe_charges" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_disputes_uq" ON "stripe_disputes" USING btree ("stripe_account_ref","dispute_id");--> statement-breakpoint
CREATE INDEX "stripe_disputes_org_idx" ON "stripe_disputes" USING btree ("organisation_id","livemode","stripe_created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_events_uq" ON "stripe_events" USING btree ("stripe_account_ref","event_id");--> statement-breakpoint
CREATE INDEX "stripe_events_org_idx" ON "stripe_events" USING btree ("organisation_id","livemode","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_payouts_uq" ON "stripe_payouts" USING btree ("stripe_account_ref","payout_id");--> statement-breakpoint
CREATE INDEX "stripe_payouts_org_idx" ON "stripe_payouts" USING btree ("organisation_id","livemode","stripe_created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_refunds_uq" ON "stripe_refunds" USING btree ("stripe_account_ref","refund_id");--> statement-breakpoint
CREATE INDEX "stripe_refunds_charge_idx" ON "stripe_refunds" USING btree ("charge_id");--> statement-breakpoint
-- Ledger lines are append-only evidence: corrections are reversal entries, never edits.
CREATE TRIGGER acct_journal_lines_no_mutation BEFORE UPDATE OR DELETE ON acct_journal_lines FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER acct_journal_lines_no_truncate BEFORE TRUNCATE ON acct_journal_lines FOR EACH STATEMENT EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER acct_journal_entries_no_truncate BEFORE TRUNCATE ON acct_journal_entries FOR EACH STATEMENT EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER acct_agreements_no_mutation BEFORE UPDATE OR DELETE ON acct_agreements FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER acct_match_history_no_mutation BEFORE UPDATE OR DELETE ON acct_match_history FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
-- Financial records are never destroyed: voiding/reversal replaces deletion.
CREATE OR REPLACE FUNCTION acct_reject_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DELETE on % is not permitted (financial record; void or reverse instead)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER acct_organiser_payments_no_delete BEFORE DELETE ON acct_organiser_payments FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER stripe_balance_transactions_no_delete BEFORE DELETE ON stripe_balance_transactions FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER stripe_charges_no_delete BEFORE DELETE ON stripe_charges FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER stripe_refunds_no_delete BEFORE DELETE ON stripe_refunds FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER stripe_disputes_no_delete BEFORE DELETE ON stripe_disputes FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER stripe_payouts_no_delete BEFORE DELETE ON stripe_payouts FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER acct_events_no_delete BEFORE DELETE ON acct_events FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
CREATE TRIGGER acct_organisers_no_delete BEFORE DELETE ON acct_organisers FOR EACH ROW EXECUTE FUNCTION acct_reject_delete();--> statement-breakpoint
-- Journal entries: content is frozen; the only permitted change is POSTED -> REVERSED (linking the reversal entry).
CREATE OR REPLACE FUNCTION acct_guard_entry() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entry % cannot be deleted; post a reversal', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.organisation_id <> OLD.organisation_id OR NEW.livemode <> OLD.livemode OR NEW.entry_type <> OLD.entry_type OR NEW.entry_date <> OLD.entry_date
     OR NEW.source_date <> OLD.source_date OR NEW.currency <> OLD.currency OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.organiser_id IS DISTINCT FROM OLD.organiser_id
     OR NEW.stripe_balance_transaction_id IS DISTINCT FROM OLD.stripe_balance_transaction_id OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
     OR NEW.description <> OLD.description OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id THEN
    RAISE EXCEPTION 'journal entry % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED' AND NEW.reversed_by_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'journal entry % status % -> % not permitted', OLD.id, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reversed_by_entry_id IS NOT NULL AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id THEN
    RAISE EXCEPTION 'journal entry % is already reversed', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER acct_journal_entries_guard BEFORE UPDATE OR DELETE ON acct_journal_entries FOR EACH ROW EXECUTE FUNCTION acct_guard_entry();--> statement-breakpoint
-- Closed accounting periods accept no new postings.
CREATE OR REPLACE FUNCTION acct_guard_period() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM acct_periods p WHERE p.organisation_id = NEW.organisation_id AND p.period = to_char(NEW.entry_date, 'YYYY-MM') AND p.status = 'CLOSED') THEN
    RAISE EXCEPTION 'accounting period % is closed', to_char(NEW.entry_date, 'YYYY-MM') USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER acct_journal_entries_period BEFORE INSERT ON acct_journal_entries FOR EACH ROW EXECUTE FUNCTION acct_guard_period();--> statement-breakpoint
-- Double entry: at commit every entry has >= 2 lines, all lines belong to the entry's organisation, and debits equal credits.
CREATE OR REPLACE FUNCTION acct_check_balanced() RETURNS trigger AS $$
DECLARE eid uuid; d numeric; c numeric; n int; bad int;
BEGIN
  IF TG_TABLE_NAME = 'acct_journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0), count(l.id), count(l.id) FILTER (WHERE l.organisation_id <> e.organisation_id)
    INTO d, c, n, bad FROM acct_journal_entries e LEFT JOIN acct_journal_lines l ON l.entry_id = e.id WHERE e.id = eid GROUP BY e.id;
  IF n < 2 OR d <> c OR bad > 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (debit %, credit %, lines %)', eid, d, c, n USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER acct_journal_lines_balanced AFTER INSERT ON acct_journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acct_check_balanced();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER acct_journal_entries_balanced AFTER INSERT ON acct_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acct_check_balanced();
