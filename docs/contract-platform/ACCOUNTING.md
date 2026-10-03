# Finance / Stripe accounting module

Enabled per deployment with `ACCOUNTING_ENABLED=true` (intended for finance.bilit.events only). When disabled every
`/api/accounting/*` route and `/api/webhooks/stripe` return 404 and the Finance menu is hidden.

## Model

- **Source of truth:** Stripe balance transactions (`txn_…`). Gross (`amount`), Stripe fee (`fee`) and `net` are stored
  separately exactly as Stripe reports them. Fees are never calculated.
- **Events and organisers** are created by an administrator (`/accounting/events`, `/accounting/organisers`). Each event has
  a unique code (case-insensitive), a currency, an optional organiser and a versioned commission agreement.
- **Matching** (`/accounting/settings`): ordered rules. The default is metadata `event_code`, then any known event code that
  appears as a word in the charge/PaymentIntent description. Prefix and regex rules are also available. If no rule matches,
  a code is unknown, several codes are found, the event is inactive, the event has no organiser, or the currency differs,
  the transaction is booked to *Unallocated Stripe Receipts* and shown under Reconciliation.
- **Ledger:** double entry (`acct_journal_entries` + `acct_journal_lines`) in integer minor units. Postgres triggers enforce
  balanced entries, immutable lines, no deletes, and no postings into closed periods. Corrections are reversals.
- **Idempotency:** unique Stripe IDs per account and mode (`stripe_bt_uq`, `stripe_events_uq`, …) plus a unique idempotency key
  per journal entry (`bt:<account>:<txn>:v<n>`). Webhook + sync + re-sync never duplicate.
- **Test vs live:** one `stripe_accounts` row per mode; every Stripe row and journal entry carries `livemode`, and every
  screen and API call is scoped to one mode.

Organiser payable per sale = gross − commission − Stripe fee (if the agreement says the organiser bears fees).
Refunds and chargebacks borne by the organiser reduce it (commission is reversed pro rata when agreed).
Outstanding = payable − organiser payments.

## Connecting production Stripe

1. Stripe Dashboard → Developers → API keys → create a **restricted key** (live) with *read* on Balance, Balance
   transactions, Charges, PaymentIntents, Refunds, Disputes and Payouts. Optional *write* on Webhook endpoints lets the app
   register its own webhook.
2. Finance → Stripe → switch to LIVE → *Connect Stripe* → paste the key (re-authentication required). The key is verified
   against Stripe, encrypted with `SETTINGS_ENCRYPTION_KEY` (AES-256-GCM), and never shown again.
3. Webhook: *Register webhook*, or create an endpoint for `https://finance.bilit.events/api/webhooks/stripe` in the
   Dashboard with the listed events and paste its `whsec_…` signing secret.
4. Stripe → Sync → *Full historical sync*. The worker (`esign-bilit-worker`) imports in the background; progress is shown live.
   An incremental sync also runs every 30 minutes.

## Local development with the Stripe CLI

```
stripe login
stripe listen --forward-to http://localhost:3000/api/webhooks/stripe   # prints whsec_… → paste into TEST mode
stripe trigger payment_intent.succeeded
```

Production never depends on the CLI.

## Operations

- Migrations: `npm run db:migrate` (adds `0009_accounting`).
- Worker queues: `accounting.sync`, `accounting.stripe_event`, `accounting.scan` (every 30 min).
- Tests use their own database: `DATABASE_URL=…/esign_test npx vitest run`.
