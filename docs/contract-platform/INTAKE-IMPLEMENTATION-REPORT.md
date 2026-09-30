# Intake-driven contract generation: implementation report

Status at the end of this work. The legal output is **drafting support for review by qualified counsel; nothing here is a statement of compliance in any jurisdiction.**

## Verified
- `tsc` (excluding stale generated `.next-*` types), `eslint src`, `next build`: clean.
- `npm test`: 128 tests, 11 files, passing on three consecutive runs against real Postgres and mailpit.
- **End to end with real SMTP (mailpit)**, `tests/e2e-intake.test.ts`: Option A (invite email → organiser form → auto-sent contract → both signers verify with the OTP emails and sign → final PDF hash = stored hash, certificate hash, valid audit chains); Option B (draft → staff approve → sent); Option C (PDF ready, nothing sent); Option A halted when formalities are required.
- **Browser smoke test** (dev server, Playwright): clause selector + policy editor, form builder, public organiser form (renders, autosaves, "Saved" indicator), staff invitation detail with unified activity timeline. This found and fixed one real bug (money-flow summary rendered objects as React children; tsc could not catch it because the client type was wrong).

## Built
Clause library (~90 English clauses, versioned, immutable), five agreement types, jurisdiction profiles (11), signing policy, legal-review flags, refund engine (A–H, 13 reasons, hierarchy, "Default Bilit Policy: Booking Fee Non-Refundable"), exclusivity and money-flow configs, PDF generation with manifest and idempotency, intake forms (21 field types, server validation, workflows A–D), secure hashed links with optional email code / passcode, drafts, submit-once, reminders, access analytics (separate tables, retention, export, erase, masking, signals), email hardening (atomic claim, suppression, idempotent events, opened/clicked timestamps, SMTP test connection + test send + headers UI), 213-row legal research matrix, UI (Templates hub, contract-template editor, form builder, invitations, access tabs, public form, settings), docs in `docs/contract-platform/architecture/`.

## Not verified / not built (read before relying on this)
1. **Legal content is unreviewed.** All seed clauses are `unreviewed`. In the matrix only 7 of 213 rows were checked against source text (42 partial, 164 unverified); most official sites blocked automated fetching.
2. **Only simple electronic signatures.** Witness, deed, AES/QES, certificate signatures and trusted timestamps are not implemented; those requirements halt auto-sending ("Additional execution formalities required.").
3. **UI is not covered by automated browser tests.** Only the smoke pass above; the clause compare view, drag-and-drop reordering (up/down buttons instead), a conditional-logic editor, clause authoring UI, and Persian clause text do not exist. The Persian UI strings are machine-quality translations that a native reviewer should check. Not visually checked at 390px or in dark mode.
4. **Email provider adapters** (SES/SendGrid/Postmark/Mailgun) are not built; only the normalised, secret-protected events endpoint. Delivery/open/click states appear only if something posts events. Statuses "created" and "queued" are one state (`QUEUED`).
5. Intake email-code and passcode *success* paths, and HTTP-layer tests of the new routes, are not automated.
6. Event labels and security-signal messages in the activity view come from the server in English.
7. In `next dev` (React strict mode) opening the public form can register two opens; production is unaffected.
8. Sent invitations keep their old form version; a form created before its fixed values were set keeps asking those fields (harmless, but redundant).
9. Reminders scan is paged; the older contract reminder scan still has its 500-row cap.
10. Nothing is committed; the working tree is untracked. Migrations added: `0005`–`0008` (0007/0008 hand-written; journal edited by hand, no drizzle snapshots).
11. `.env` `SMTP_HOST=localhost` drops connections on Docker Desktop (IPv6); tests pin `127.0.0.1`.
