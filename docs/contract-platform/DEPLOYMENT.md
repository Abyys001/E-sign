# Deployment

## Requirements
Node 22+ (developed on 24), PostgreSQL 17, an SMTP server, optional S3-compatible storage, optional Twilio account for SMS, optional ClamAV.

## Environment
Copy `.env.example`. Required in production: `APP_URL` (exact public origin, used for CSRF and links), `DATABASE_URL`, `SESSION_SECRET`, `SIGNING_TOKEN_SECRET`, `OTP_SECRET`, `WEBHOOK_SECRET`, `SETTINGS_ENCRYPTION_KEY` (each `openssl rand -hex 32`, all different), SMTP settings, and storage settings. Changing `SIGNING_TOKEN_SECRET` invalidates all outstanding signing links; changing `SETTINGS_ENCRYPTION_KEY` makes stored SMTP/SMS/webhook secrets unreadable.

On macOS + Docker Desktop use `127.0.0.1`, not `localhost`, for `SMTP_HOST`: `localhost` may resolve to `::1` and the forwarded port drops the connection ("Connection closed unexpectedly").

## First run
```
docker compose up -d           # postgres + mailpit (dev)
npm ci
npm run db:migrate
ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_ORG=… ADMIN_PASSWORD=… npm run bootstrap
npm run build && npm run start   # web
npm run worker                   # separate process; required for email/SMS/webhooks/finalisation/reminders
```

## Operations
- Health: `GET /api/health`.
- Run **one or more** workers; pg-boss coordinates them. Restarting is safe (jobs are retried with backoff, dead-lettered after the limit).
- Behind a proxy: terminate TLS, overwrite `X-Forwarded-For`, keep `APP_URL` equal to the public origin.
- Backups: the database and the storage area together; they reference each other by object id.
- Retention: configurable per organisation in Settings → Retention; the scheduled scan purges objects after the configured period and records it. Auto-delete is off by default.
- Test data: `npm run seed:test` creates clearly labelled `[TEST DATA]` drafts; it refuses to run with `NODE_ENV=production`.
