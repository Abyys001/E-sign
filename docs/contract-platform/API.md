# API guide

`openapi.json` (regenerate with `npm run openapi`) lists every route, method, auth mode and required permission, generated from the route files. Bodies are validated with zod; this guide describes the conventions.

## Auth
- Browser: session cookie + `x-csrf-token` on mutations.
- Server-to-server: `Authorization: Bearer bes_live_…` (create under Developers → API keys; shown once).

## Errors
```json
{ "error": { "code": "validation_failed", "message": "…", "details": [{"path":"email","message":"…"}], "correlationId": "…" } }
```
Codes include `unauthenticated` 401, `forbidden` 403, `elevation_required` 403, `not_found` 404, `gone` 410, `precondition_failed` 412, `payload_too_large` 413, `unsupported_media` 415, `validation_failed` 422, `rate_limited` 429, `internal` 500. Send `x-correlation-id` to trace a request; it is echoed back and logged.

## Idempotency
`POST /api/contracts/{id}/send` honours an `Idempotency-Key` header; repeating it returns the original result instead of sending twice.

## Webhooks
Subscribe under Developers → Webhooks. Deliveries follow Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 hmac>`). Failures retry with backoff; failed deliveries can be redelivered from the UI. Events: `contract.created`, `contract.sent`, `contract.viewed`, `contract.signed`, `contract.completed`, `contract.declined`, `contract.cancelled`, `contract.expired`, `contract.voided`, `recipient.added`, `recipient.completed`.

## Intake, templates and generation
Internal routes use the same auth as the rest of the API (session + CSRF, or an API key with the permission). Route inventory and permissions are in `openapi.json` (regenerate with `npm run openapi`). Notable groups: `/api/agreement-types`, `/api/agreement-templates*`, `/api/clauses*`, `/api/intake-forms*`, `/api/invitations/[id]/*`, `/api/contracts/[id]/approve-for-signature`, `/api/legal/matrix`. Public intake routes (`/api/intake/[token]/*`) authenticate with the link token plus a browser-bound session cookie. List endpoints for access analytics accept `page`, `pageSize`, `from`, `to`, `invitationId`, `browser`, `os`, `deviceType`, `ip`, `sessionId`, `type`. Submit accepts an `Idempotency-Key` header.
