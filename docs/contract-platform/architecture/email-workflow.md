# Email workflow

All mail goes through `queueEmail` (transactional outbox, unique `dedupe_key`) → pg-boss `email` queue → `deliverEmail` → nodemailer. Platform SMTP from env, or the organisation's own SMTP in **Settings → Email** (password AES-GCM encrypted).

## Templates
24 keys, en + fa, editable per organisation (Settings → Email templates, with live preview and variable validation). Added for this feature: `intake_invitation`, `intake_reminder`, `intake_submitted`, `contract_generated`, `contract_ready_for_review`, `contract_rescheduled`, `refund_notice`. The intake link is derived at send time and is never stored in the message payload.

## Statuses
`QUEUED` (row committed + job enqueued in one transaction; this is both "created" and "queued") → `SENDING` (atomic claim) → `SENT` (SMTP accepted) → `DELIVERED` / `BOUNCED` / `COMPLAINED` (provider events) · `FAILED` · `SUPPRESSED`. **Opened and clicked are timestamps** (`opened_at`, `clicked_at`), not statuses. Only provider events can move a message past `SENT`; without them the UI honestly shows "sent".

## Guarantees
- **Atomic claim:** `UPDATE … WHERE status='QUEUED'` — duplicate jobs or sweeps cannot double-send. A worker that dies mid-send leaves `SENDING`; the sweeper releases it after 5 minutes (at-least-once in that crash window).
- **Retry** with backoff; the final failure is recorded and staff notified. Messages for revoked/expired links are skipped.
- **Suppression:** a bounce or complaint adds the address to `email_suppressions` (per organisation); later sends are `SUPPRESSED` and audited.
- **Idempotent events:** unique `(message, type, occurred_at)`; a redelivered event changes nothing.
- **Reminders:** slot-unique (`intake_reminders`), paged scan, only the newest overdue slot is emailed.

## Settings UI
SMTP host/port/TLS/user/password, from name/address, reply-to, extra headers, **Test connection** (`verify()`, sends nothing) and **Send test email** (real message to you; reports the server's actual answer). Provider events: `POST /api/webhooks/email-events` with the shared secret (normalised shape).

Not built: provider-specific webhook adapters (SES/SendGrid/Postmark payload parsers) — they need live accounts to verify; the normalised endpoint is what exists. Open tracking is only as reliable as the provider's pixel.
