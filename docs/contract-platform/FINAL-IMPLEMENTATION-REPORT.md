# Bilit.event E-Sign — final implementation report

Date: 2026-09-29. Status: working end to end in local development; **not** production-hardened or independently audited. Read "Not done" before deploying.

## Verified results

| Check | Result |
|---|---|
| `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) | clean |
| `eslint src` | clean (rule exceptions documented in `eslint.config.mjs`) |
| `vitest run` | 6 files, 60 tests passing (real Postgres) |
| `next build` | compiles; 68 API route files + 19 pages |
| Manual browser run (Playwright, real Postgres/Mailpit/worker) | see below |

Manual run, each step performed against the live app, no stubs: sign in → upload PDF (server preflight, page render in editor) → add recipient (email-code verification) → place signature field → mark ready → send → invitation email delivered via SMTP (Mailpit) → open signing link → request OTP, read it from the delivered email, verify → typed signature, consent → finish → worker finalised the PDF and certificate → download page → public verification page showing hashes, signer, audit chain intact. Also seen: Persian + RTL + dark + 390 px viewport on the contract page; CSRF rejection of a session request without token (403); unauthenticated API calls (401).

## What exists

- **Sender**: dashboard (live counts, trend), contracts list (filter, search, bulk, export), create from PDF / template / copy, recipient management, field editor (16 field types, drag/resize/snap/undo/keyboard, thumbnails, page repeat), readiness check, send, remind, resend, reassign, cancel, void, archive, 9-tab detail (overview, document, recipients, progress, activity, audit trail with chain check + CSV/JSON export, messages, versions, downloads).
- **Signer**: secure link, browser-bound session, email/passcode/account verification (SMS when a provider is configured), guided field filling, typed/drawn/uploaded signatures (non-Latin text rendered client-side), consent, decline with reason, completion page with signed PDF and certificate.
- **Evidence**: hash-chained audit events, append-only signatures, locked versions, completion certificate with QR, SHA-256 of source and final, public verification page with in-browser hash check.
- **Admin**: members/roles/invites, org switcher, settings (general, branding + logo, signing, SMTP + test send, SMS + test, notifications, reminders, retention, security), editable email templates with sandboxed preview, notifications centre, audit log, account (TOTP, re-auth), developers (API keys, webhooks with delivery log, rotate, test, redeliver).
- **Platform**: outbox + pg-boss worker (email, SMS, webhooks, finalise; expiry, reminders, retention schedules), S3/local storage, rate limits, idempotency keys, SSRF-guarded signed webhooks.
- **UX/design**: only the 13 supplied palette colours; Google Sans Flex 400 (Vazirmatn for Persian); the supplied GIF logo unaltered, static PNG only for reduced motion, email and PDF; English + Persian with RTL and Jalali dates; skip link, focus rings, labelled controls, reduced-motion support.

## Design decisions to know about

- **No red/amber in the palette.** Status is conveyed by icon + text label + border style (solid/dashed/dotted/double), never colour alone. Accent green carries dark text for contrast. Sidebar, auth hero and signing/verify headers are dark in both themes so the light-lettered logo stays legible.
- Verification ids are random and separate from contract ids (no enumeration).
- Signing link opens are bound to one browser; a second browser forces re-verification.

## Defects found and fixed during this final pass

- Tailwind scanned tool logs in the project tree and produced corrupted CSS, taking the whole app to HTTP 500. Sources are now restricted (`@source`) and tool output is git-ignored.
- `package.json` was `"type": "commonjs"` while all source is ESM; the app returned 500 until set to `module`.
- Invitation and SMS links pointed to `/sign/<token>` but the page lives at `/s/<token>` (404 for every signer). Fixed in `messaging/email.ts` and `messaging/sms.ts`.
- Plain-text email alternative ran the button and fallback link together and duplicated URLs; fixed in `messaging/render.ts`. Email footer rule used a non-palette grey.
- `common.status` was used as a string while it is an object (rendered raw key on the contract page); added `common.statusLabel`. `i18n-usage.test.ts` now fails on this class of bug.
- Missing Persian string (`audit.contract_sent`); template names did not match the real template keys.
- Locale switch was invisible on the always-dark signing/verify header.
- Contract detail API leaked recipient `passcodeHash` to any viewer; TOTP enrolment could replace a live secret without a password (earlier segment, fixed).
- Empty bordered body in the Send confirmation dialog.
- Hard-coded English in account page, template role defaults, spinner/toast/pagination/chart accessibility labels moved to i18n.

## Environment notes

- Docker Desktop on macOS: use `SMTP_HOST=127.0.0.1` (`localhost` → `::1` dropped connections). `.env.example` now says so; your local `.env` is unchanged.
- `next dev` generated `AGENTS.md` and `CLAUDE.md` in the project root; they are untouched (tooling files, not part of the product). `agentRules: false` prevents regeneration.
- A second dev instance can run with `NEXT_DIST_DIR=.next-3100 APP_URL=http://localhost:3100 next dev -p 3100`. A dev server on port 3001 from an earlier session may still be running.
- `npm run seed:test` adds three `[TEST DATA]` drafts to the first organisation owner's org; it was run once locally.

## Not done / limitations (honest list)

- No automated browser E2E suite; the manual run above is not repeatable CI evidence. HTTP-level tests for concurrent signing, upload abuse, webhook SSRF/signature, retention, reminders and expiry jobs are missing (see `TESTING.md`).
- Only the email-OTP path was exercised in the browser this session; drawn/uploaded signatures, passcode, account verification, SMS OTP, decline, sequential multi-signer, templates UI, webhooks UI, API-key UI and members/invite UI were built and type/lint/build-checked but not clicked through here. Multi-signer sequencing and finalisation are covered by `flow.test.ts`.
- SMS delivery was never run against a real provider; there is no provider account here.
- The OpenAPI file is a generated route inventory (paths, methods, auth, permission) without request/response schemas.
- PDF parsing is not sandboxed in a killable worker; `X-Forwarded-For` trust depends on the proxy; no penetration test; no trusted timestamping or certificate-based PDF signatures.
- No legal-compliance claim is made for any jurisdiction (eIDAS, ESIGN/UETA, etc.). Legal validity depends on law and the agreement; get legal review before relying on this for regulated documents.
- Reusable components were not synced back into `~/Project/engineering-kit`.
- Nothing has been committed; the working tree is entirely untracked.
