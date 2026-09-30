# Security model

Threat-model notes and what is implemented. Items under **Not done / known limits** are real gaps, not omissions from this list.

## Tenancy
Every table carries `organisation_id`; every query filters on it. Cross-tenant access returns 404, not 403 (tested in `tests/security.test.ts`).

## Authentication
- Passwords hashed with argon2id (OWASP minimum profile); sessions are random tokens stored **hashed**; cookie `bes_session` is HttpOnly, SameSite.
- CSRF: `bes_csrf` double-submit (`x-csrf-token`) plus `Origin` check against `APP_URL`, on every browser-session mutation. Bearer API keys are exempt (not ambient credentials).
- TOTP 2FA; enrolling refuses when a TOTP secret already exists (prevents silent replacement).
- Sensitive actions (settings that carry secrets, API keys, deletes, retention) need a recent password re-entry ("elevation").
- API keys: `bes_live_<prefix>_<secret>`, stored hashed, carry an explicit permission list, can never exceed their creator's permissions, revocable.

## Signing links
- Token is HMAC-derived from `(request id, nonce)`; only its hash-relevant parts are stored. Guessed or malformed tokens get generic client errors.
- The first open binds a browser session cookie (`sg_<id>`); opening the link in a second browser invalidates the first and asks to verify again.
- Verification levels: link only, email OTP, passcode, signed-in account. SMS OTP is offered only when an SMS provider is configured. OTPs are 6 digits, HMAC-hashed, session-bound, attempt- and rate-limited, expiring.
- Consent is recorded with the text shown. Every signature row is append-only.

## Evidence integrity
- Audit events are hash-chained per contract (`prev_hash`, `hash`) with canonical JSON; UPDATE/DELETE are blocked by triggers, including for raw SQL. Concurrent appends keep a valid chain (tested).
- Signatures, locked versions and the field layout after send are immutable at the DB level (tested).
- Final PDF and certificate hashes are shown on the public verification page; users can hash their own copy in the browser (file never uploaded).

## Data handling
- Uploads: PDF only, size and page limits, JavaScript / OpenAction rejected, optional ClamAV.
- Storage keys are generated; traversal attempts are rejected (tested). Downloads stream through an authorised route (or a 60 s presigned redirect on S3) and create a `downloads` row and an audit event.
- Stored SMTP/SMS secrets are AES-256-GCM encrypted; API responses never return them.
- Webhooks: Standard-Webhooks HMAC signatures, per-endpoint secrets (AES-GCM at rest, rotatable), SSRF guard (private ranges blocked unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`, dev only).
- Response headers: CSP, X-Frame-Options DENY, nosniff, Referrer-Policy no-referrer, restrictive Permissions-Policy.
- Rate limits (DB-backed) on login, OTP, downloads, API, webhook tests.

## Intake links and access analytics
- Intake tokens use the `ik:` HMAC domain; only a hash is stored. Bad, expired and revoked tokens are rate-limited per IP and indistinguishable from the outside except for a generic message. Staff can copy a link only through an audited, elevated action.
- Public mutations require a hashed-cookie session bound to the invitation; optional email code or passcode (Argon2) gates the form.
- Submissions are idempotent and lock on submit; uploads are magic-byte checked, size-capped, stored in a separate area and only downloadable by staff.
- Access telemetry is separate from answers, append-only (only the `ip` column may be edited, by the retention job), gated by `intake.telemetry`, masked otherwise, exportable and erasable, and retention-limited (Settings → Privacy & analytics). No fingerprinting; signals are prompts, not accusations.
- The logger redacts bearer tokens in URLs and query strings as well as sensitive keys.
- Email: atomic send claim, per-organisation bounce/complaint suppression, idempotent provider events.

## Not done / known limits
- Organiser uploads pass the same optional ClamAV scan as other uploads; without ClamAV configured only type/size/magic-byte checks apply.
- The clause text and jurisdiction profiles are drafting aids; none has been reviewed by counsel.
- PDF parsing runs in the web/worker process, not a killable sandbox; a pathological PDF is bounded by size/page limits only.
- `X-Forwarded-For` is read from the right by `TRUSTED_PROXY_HOPS` (default 1). Set it to the real number of proxies in front of the app (0 ignores the header). A wrong value makes IPs, rate limits and access analytics inaccurate.
- Attachments uploaded during signing are not bound to a field until submit; orphan objects are possible (low impact).
- No penetration test or third-party audit has been performed.
- Advanced/qualified electronic signature schemes, trusted timestamps and certificate-based PDF signing are not implemented.
