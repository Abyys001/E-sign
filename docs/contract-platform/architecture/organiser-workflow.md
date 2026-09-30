# Organiser workflow and access analytics

## What the organiser sees (`/intake/[token]`)
Email link → optional verification (email code / passcode) → stepper form with progress bar → **autosave** (debounced, plus on section change and page hide) → **Save and finish later** → **Submit**. After submit the form is locked and shows a confirmation. Errors from the server are shown per field. Language switch en/fa (RTL).

- **Save vs submit:** a save is a draft (lenient validation). Submit re-validates everything, locks the form, is idempotent (`Idempotency-Key`, unique per invitation) and a replay or double click never creates a second contract.
- Public routes are rate-limited (bad-token guesses per IP, opens, sessions, saves, submits, OTPs, uploads, heartbeats). Bad, expired and revoked tokens are indistinguishable to the caller except for a generic "expired or withdrawn" message.
- Uploads: PDF/PNG/JPEG/DOCX, magic-byte checked, size-capped, stored under the `intake` area, downloaded only by staff as attachments.

## Access analytics
Recorded **from the first open, before any answer exists**, in tables separate from the answers (`intake_access_sessions`, append-only `intake_access_events`).
- A session is a hashed cookie. An *open* is a new session or a return after 30+ minutes idle. Heartbeats every 30 s (server-throttled to ≥15 s); *active* means seen in the last 2 minutes; active time is approximate.
- Client reports only screen size, pixel ratio, language, time zone and platform — no canvas/font/audio fingerprinting. `device_key` is a coarse grouping hash, never an identity.
- IP comes from `X-Forwarded-For` counted from the right by `TRUSTED_PROXY_HOPS` (default 1; 0 ignores forwarding headers).
- **Security signals** ("Unusual access pattern: …") are prompts for a human, never accusations.
- Viewers without `intake.telemetry` see IPs masked (/24, /48) and no device detail.
- Section progress stores section key + entered/completed, never answer values.

## Privacy and retention (Settings → Privacy & analytics)
`ipAnonymiseDays` truncates stored IPs (`a.b.c.0`, IPv6 /48); `telemetryDays` deletes old sessions and events. A retention job runs with the existing retention scan. Per-invitation **export** (`GET /api/invitations/[id]/telemetry`) and **erase** (`DELETE`, needs `settings.manage`, audited with counts). Answers, audit records and signed evidence follow their own settings. The form shows a configurable privacy notice.
