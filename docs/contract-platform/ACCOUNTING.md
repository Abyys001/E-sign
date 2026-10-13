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

## Bilit AI Accountant (Financial Overview)

Floating assistant on **Finance → Financial Overview** (`/accounting/position`). It is read-only: it answers questions in English or Persian, by text or voice, using only the figures that the finance services calculate. Other Finance pages keep the existing finance chat, which can propose changes.

**How answers are produced.** The model gets read-only tools that call the existing services and nothing else: `financialPosition`, `financeOverview`, `eventFinancials`, `booksOverview`, `monthlySeries`, `bookkeepingChecks`, `listPayments`, `listTransactions` and `listBills`. It has no write tools and no SQL access. Every query is scoped on the server to the caller's organisation and test/live mode. Amounts are integer minor units, and the model receives them already formatted. Any extra sum goes through the `calculate` tool, which uses exact minor-unit arithmetic. Each tool call is returned as **evidence** next to the answer (period, formula, sources, number of records, limitations, calculation time) together with data freshness (last Stripe and Wise sync). Ticket buyers' names, e-mails and Stripe descriptions are never sent to the model. Code: `src/server/accounting/ai-accountant.ts`.

**Voice.** Speech-to-text and text-to-speech use OpenAI through the same key (`src/server/accounting/ai-voice.ts`). Recordings go to OpenAI once and are never written to disk, storage or logs. Spoken text is cleaned up first: markdown removed, tables read row by row, negative amounts read as "minus" / «منفی».

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /api/accounting/ai/accountant?mode=` | accounting.view | `{ messages, language: auto\|en\|fa, context: { page, from, to, currency, focus } }` → `{ answer, language, dir, steps, evidence, freshness, model, asOf }`. Rate limit `aiChat` (40 / 10 min per user). |
| `POST /api/accounting/ai/voice/transcribe` | accounting.view | multipart `audio` (≤ 10 MB, webm/ogg/mp4/mp3/wav), `language`. Rate limit `aiVoice` (60 / 10 min). |
| `POST /api/accounting/ai/voice/speak` | accounting.view | `{ text, language }` → `audio/mpeg`. Rate limit `aiVoice`. |

**Setup.** There are no new environment variables or migrations; this reuses `ACCOUNTING_ENABLED=true` and the encrypted settings. Go to *Finance settings → AI accountant*:
1. Paste an OpenAI API key and enable the AI accountant. The key is stored encrypted and is write-only; changing it needs elevation. Choose the chat model (default `gpt-4.1`).
2. *Bilit AI Accountant*: default answer language, maximum answer tokens (default 1800), OpenAI timeout (90 s) and retries on timeouts / 429 / 5xx (1).
3. *Voice*: enable it, then choose the speech-to-text model (default `gpt-4o-transcribe`), the text-to-speech model (default `gpt-4o-mini-tts`), the English and Persian voices, automatic read-aloud, and the longest recording. The key needs access to the audio models.

When no key is configured, the widget tells the user that an admin must set it up. When voice is off, the microphone is disabled and its tooltip explains why.

**Audit.** These actions are written to the audit log: `accounting.ai_accountant.asked` (question shortened to 300 characters, language, mode, tools and periods used, model, tokens, duration; no figures), `accounting.ai_accountant.voice_in` and `accounting.ai_accountant.voice_out` (sizes, language, model; never the words or the audio).

**Tests.** `tests/ai-accountant.test.ts` covers figures checked against Stripe fixtures, evidence, Persian and English, refunds, period and event filters, read-only behaviour and prompt injection, tenant isolation, retries, timeouts, missing credentials, the route's permissions and validation, voice in and out, and upload validation.
