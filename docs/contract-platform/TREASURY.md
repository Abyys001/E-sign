# Staff card portal (Stripe Treasury + Issuing)

Employees sign in at **`/staff/treasury/login`** and see **only the company card(s) assigned to them**. Administrators manage cards, staff, limit requests, expenses and the audit trail under **Finance → Treasury cards** (`/accounting/treasury`). Staff never get a Stripe Dashboard login or any Stripe credential.

The module is additive. It adds new tables (`treasury_*`) and one column (`acct_settings.treasury_settings`). It does not change any existing finance, accounting or payout behaviour.

## How the Stripe pieces relate

| Object | Stripe API | Stored locally |
|---|---|---|
| Treasury financial account (`fa_…`) | `treasury.financial_accounts` | id only, in Treasury settings |
| Cardholder (`ich_…`) | `issuing.cardholders` | `treasury_cardholders` (name, email, status) |
| Card (`ic_…`) | `issuing.cards`, created with `financial_account` = the Treasury account, so spend is funded from the Treasury balance | `treasury_cards` (brand, last4, expiry, status, spending controls, nickname) |
| Authorisations / transactions | `issuing.authorizations`, `issuing.transactions` | **not stored**. Read live from Stripe on every view. Only staff notes and receipts are stored (`treasury_expenses`) |
| Staff ↔ card | none (Bilit-only concept) | `treasury_assignments` (history kept; one active holder per card, enforced by a partial unique index) |

This is separate from the other Stripe integrations. The accounting importer key, the Global Payouts key and the `fa_…` money-management account used by **Send money** are not used here.

## Setup

1. **Stripe.** Enable **Issuing**, and **Treasury** if cards should spend from a financial account, on the Stripe account, in test mode first.
2. **Restricted key.** Create one per mode with **Issuing: Write** and **Treasury: Write** (read is implied), and nothing else.
3. In **Finance → Treasury cards → Settings**, paste the key and click **Save & test**. The app tests the key, shows which capabilities exist (Issuing / Treasury) and lists financial accounts. Pick the account cards spend from. The key is stored encrypted (AES via `ENCRYPTION_KEY`) and is never returned to the browser.
4. **Webhook.** In Stripe, add an endpoint to the URL shown on the Settings card (`https://<host>/api/webhooks/stripe-issuing`). Subscribe to `issuing_card.created`, `issuing_card.updated`, `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created` and `issuing_transaction.updated`. Paste the signing secret (`whsec_…`) into Settings.
   **Do not subscribe to `issuing_authorization.request`.** That is real-time approval, and this module never approves spend. Stripe would apply your account's default decision.
5. **Cards.** Either create them in the app (*Create card*: cardholder + currency + limits), or create them in Stripe and click *Sync from Stripe*.
6. **Staff.** *Staff → Add staff* creates an INVITED account and emails a 7-day single-use link. The link is also shown so you can copy it if email isn't configured. The person sets a password (minimum 10 characters) and the account becomes ACTIVE.
7. **Assign.** *Cards → Assign* links a card to a staff member. A person may hold several cards; a card has at most one active holder.

Test end to end in **test mode** (mode switch in the finance header) before entering a live key.

## Permission matrix

| Action | Staff (own card only) | Admin (`treasury.admin`) | Notes |
|---|---|---|---|
| Sign in / out, reset own password | ✓ | – | separate session cookie `bes_tstaff`, 12 h, server-side rows |
| See own card: brand, last4, expiry, status, configured limits | ✓ | ✓ (all cards) | full PAN / CVC never fetched or stored |
| See own card activity (authorisations + transactions) | ✓, **only since their assignment began** | ✓, all history, with who held the card when | read live from Stripe |
| Add a note / upload a receipt to a transaction | ✓, own card, own period, own row only | view | PDF/PNG/JPEG/WebP, magic-byte checked, virus-scanned |
| Freeze / unfreeze own card | only if the admin allowed it for that person | – | a cancelled card can't be reactivated |
| Request a spending-limit change | ✓ | approve / reject (re-auth) | approval writes the new limit to Stripe |
| Treasury balance, transfers, payouts, add funds, bank details | ✗ | ✗ in this module | no such endpoint exists in the staff API |
| Create cardholder / card | ✗ | ✓ (re-auth) | |
| Create / suspend / revoke staff, freeze policy | ✗ | ✓ (suspend/revoke need re-auth) | suspend/revoke ends all sessions at once; revoke is final and ends assignments (history kept) |
| Assign / revoke a card | ✗ | ✓ (re-auth) | |
| Expense list + CSV export | ✗ | ✓ | export is audited |
| Audit trail | ✗ | ✓ | |
| Treasury settings (key, account, webhook secret) | ✗ | ✓ (re-auth) | |

`treasury.admin` is part of the **Organisation owner**, **Super admin** and **Admin** roles. Other roles don't get it.

## Security model

- **One authorisation point.** `src/server/treasury/access.ts → authorizeCard()`. The card is resolved from the staff member's *own active assignment* in the database. A card id from the browser can only pick among those cards; anything else returns 403 and is audited. It also returns the assignment start, and all activity, notes and receipts are cut off before it. When a card changes hands, the new holder sees nothing from the previous holder.
- **Transaction ownership.** Before a note or receipt is stored, the Stripe object is retrieved by id. It must belong to the card and be dated after the assignment started. Notes are upserted only when the existing row is the staff member's own.
- **Field allow-list.** Staff endpoints return fixed view objects (`CardView`, `Activity`), never raw Stripe objects.
- **Sessions.** Opaque random token in an httpOnly, `SameSite=Lax`, `Secure` cookie. Only its HMAC is stored. Every request re-reads the staff row, so suspension takes effect immediately. CSRF uses a per-session token held server-side, which must be sent as `x-csrf-token` and is compared in constant time.
- **Login.** Generic errors; equalised timing for unknown emails; 8 failures lock the account for 15 minutes; rate limits per IP (20/15 min) and per email (6/15 min). Staff emails are unique across organisations.
- **Password reset.** Self-service ("Forgot your password?") or admin "Resend". The response is identical whether or not the account exists. The link is 1 h, single use, and resetting ends all sessions.
- **Webhooks.** The signature is verified against each configured secret. An event's `livemode` must match the mode of the secret that verified it. Event ids are recorded first, so a redelivery is a no-op. If processing fails, the id is removed and a 5xx returned so Stripe retries. Webhooks only mirror card status and controls; they never move money.
- **Audit** (`treasury_audit`). Logins (OK/DENY), denied card access, freezes, limit requests and decisions, staff and assignment changes, settings changes, exports and webhook events, each with actor, time, action, resource, outcome and IP. Metadata keys that look like secrets are redacted.
- **PCI.** The app never retrieves, displays or stores the full card number or CVC. It holds only brand, last4 and expiry, which keeps it out of PAN scope.

## Not supported (shown as "not available", never simulated)

- **Remaining spend against a limit.** Stripe exposes the *configured* `spending_limits`, not the amount left. The portal shows the configured limits only.
- **Full card number / CVC for virtual cards.** This would need Stripe Issuing Elements with ephemeral keys. Not built, by design (PCI).
- **Physical cards.** These need a shipping address, which the create form doesn't collect. Stripe rejects the request with a clear error. Create physical cards in the Stripe Dashboard and *Sync*.
- **MFA for staff.** Password-only was chosen. The schema and session design allow TOTP to be added later.
- **Treasury balance.** It is never shown to staff. Admins see financial account ids, not balances, in this module. Balances stay on the Financial Overview.
- **Real-time authorisation decisions** (`issuing_authorization.request`): see Setup step 4.

## Endpoints

Staff (session cookie + CSRF on POST): `POST /api/staff/treasury/login`, `POST /logout`, `POST /forgot`, `POST /accept-invite/:token`, `GET /session`, `GET /cards`, `GET /cards/activity?cardId=`, `POST /cards/freeze`, `GET|POST /limit-requests`, `POST /expenses`, `POST /expenses/receipt`, `GET /receipts/:stripeObjectId`. All of these sit under `/api/staff/treasury`.

Admin (`treasury.admin`): `GET|PATCH /settings`, `GET /capabilities`, `GET|POST /cardholders`, `GET|POST /cards`, `POST /cards/sync`, `GET /cards/:id/activity`, `POST /cards/:id/assign`, `POST /cards/:id/revoke`, `GET|POST /staff`, `POST /staff/:id/status|resend|freeze-policy`, `GET /limit-requests`, `POST /limit-requests/:id/decide`, `GET /expenses`, `GET /expenses/export?from=YYYY-MM-DD&to=YYYY-MM-DD`, `GET /receipts/:expenseId`, `GET /audit`. All of these sit under `/api/accounting/treasury`.

Webhook: `POST /api/webhooks/stripe-issuing`.

## Tests

`tests/treasury.test.ts` (fake Stripe gateway, no network) proves:
- staff A can't reach staff B's card;
- a tampered or foreign card id is denied and audited;
- the staff API has no balance or money-movement function;
- limits can only be requested, and freezing obeys policy;
- admin approval writes the limit;
- suspend and revoke end access at once, and revoke is final;
- a card can't have two holders;
- a card that changes hands hides the previous holder's activity, notes and receipts, while the export still attributes each row correctly;
- notes can't target another card's transactions;
- emails are unique across organisations;
- CSRF must match exactly;
- forgot-password gives the same answer for every account and only mails active ones;
- webhooks reject forged, wrong-mode and duplicate events, and let failed events be retried.
