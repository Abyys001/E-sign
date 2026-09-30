# Testing

`npm test` (vitest, needs the local Postgres from `docker compose`), `npm run typecheck`, `npm run lint`, `npm run build`.

| File | Covers |
|---|---|
| `foundation.test.ts` | state machine, RBAC, crypto/OTP/encryption, storage traversal, audit chain + immutability triggers, concurrent appends, evidence immutability |
| `flow.test.ts` | two-signer sequential flow: send, sign in order, finalise, audit chain valid |
| `pdf-placement.test.ts` | stamped signature placement at 0/90/180/270° rotation; PDF preflight rejects non-PDF, JavaScript/OpenAction, limit violations |
| `security.test.ts` | tenant isolation (read/edit/delete by id), permission scoping of API keys, revoked/malformed keys, guessed signing tokens, cross-site POST blocking |
| `engines.test.ts` | condition evaluator, variable rendering, clause composition, refund engine matrix, exclusivity/money-flow, signing policy, legal flags |
| `generation.test.ts` | template publish/immutability (DB triggers), PDF + manifest + traceability, deterministic hash, generation-key idempotency, unresolved-variable failure, audit events |
| `intake.test.ts` | link lifecycle (hash-only tokens, revoked/expired, passcode gate), autosave/resume on another device, submit once + replay + lock, workflows B/C/D, reopen, tenant isolation, telemetry before submit, IP masking, pagination/filters, append-only events, retention (anonymise then delete), export/erase |
| `e2e-intake.test.ts` | **end to end through real SMTP (mailpit):** Option A (invite email → organiser form → contract auto-sent → both sign with real OTP emails → final PDF hash, certificate, valid audit chain), Option B (draft → staff approve → sent), Option C (PDF ready, nothing sent), Option A halted by required formalities |
| `hardening.test.ts` | trusted-proxy `clientIp`, URL-token log redaction, legal-matrix integrity, atomic email claim, provider-event idempotency + open/click timestamps, bounce suppression, reminder slots once, bad-token rate limiting |
| `i18n.test.ts` | en/fa key parity per namespace |
| `i18n-usage.test.ts` | every literal `t("…")` key used in source resolves to a string in `en` |

Verified by hand in a browser (not automated): login, upload, recipient, field placement, mark ready, send, email delivery through Mailpit, email OTP, typed signature, consent, finalisation, download page, public verification, Persian/RTL + dark + 390px viewport.

The e2e suite needs mailpit on `127.0.0.1:1025/8025` (`docker compose up`). It pins `SMTP_HOST=127.0.0.1` because `localhost` can resolve to `::1`, where Docker's port proxy drops SMTP connections.

## Not automated
- **Browser tests of the new UI** (template/clause/form builders, public organiser form, access tabs, settings). These pages are type-checked, linted and built, and the APIs behind them are tested, but no Playwright run drives them. Render them by hand before relying on them.
- HTTP-layer tests of the new routes (the services are tested directly; the route files are thin wrappers).
- Concurrent-signature races at HTTP level, webhook SSRF/signature unit tests, upload-abuse tests at HTTP level, intake-form email-code verification (`EMAIL_OTP`) and passcode success paths (only the gate for unverified sessions is covered; signing OTP is covered end to end).
- Real-provider delivery events (SES/SendGrid/Postmark): the normalised endpoint is covered; provider payload adapters do not exist.
- Legal correctness of clause text or of any matrix row.
