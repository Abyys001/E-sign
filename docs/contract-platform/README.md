# Bilit.event E-Sign — architecture

Multi-tenant contract and electronic-signature platform. Sender workflow (upload → recipients → fields → send → track), signer workflow (secure link → verify → sign → download), public verification, admin, webhooks, i18n (English, Persian/RTL).

This is software that records evidence of who signed what and when. It does **not** by itself make any signature legally valid in any jurisdiction; that depends on applicable law and the agreement. No compliance certification is claimed.

## Stack

| Concern | Choice |
|---|---|
| App | Next.js 16 (App Router, Turbopack), React 19, TypeScript strict |
| UI | Tailwind v4, lucide-react, next-intl (cookie locale, en + fa), own component kit in `src/components/ui` |
| Data | PostgreSQL 17, Drizzle ORM, SQL migrations in `drizzle/` |
| Jobs | pg-boss with a transactional outbox (a job is only enqueued if the business transaction committed) |
| PDF | pdf-lib (stamping, final PDF), pdfjs-dist (browser viewer), pdfkit (certificate) |
| Storage | Local disk or S3-compatible, addressed by generated keys only |

## Intake-driven contract generation
Template → clause selection → jurisdiction → intake form → secure email → organiser form → contract generation → review or auto-send → e-signature → certificate. See [architecture/](architecture/README.md) (10 topic docs) and the [legal research matrix](../legal/research-matrix.md). Generated contracts are drafting support and are not represented as legally compliant.

## Processes

- **web** — `npm run start` (or `npm run dev`). Serves UI and `/api/*`.
- **worker** — `npm run worker`. Consumes queues: email, sms, webhooks, finalize, plus intake generation and reminders, schedules for expiry scan (5 min), reminders scan (5 min), outbox sweep (1 min), retention scan (daily 03:17). **Nothing is delivered unless a worker is running.**

## Module map (`src/server`)

`agreements/` templates · `clauses/` versioned library · `variables/` · `policy/` refund, exclusivity, money flow · `legal/` jurisdictions, signing policy, review flags, research matrix · `generation/` clause tree to PDF · `intake/` forms, invitations, public form, analytics · `contracts/` state machine, service, field routing · `signing/` token session, OTP, submit, finalize, certificate · `audit.ts` hash-chained events · `messaging/` email/SMS rendering and delivery · `webhooks/` Standard-Webhooks signed delivery · `settings/` typed org settings · `storage/` providers · `auth/` sessions, TOTP, API keys · `rbac.ts` roles and permissions · `jobs/` queues.

Reusable pieces (field model, PDF placement, hashing, webhook signing, recipient routing) live in `src/server/kit`, sourced from the shared engineering-kit and adapted.

## Contract lifecycle

`DRAFT → READY_TO_SEND → SENT → (DELIVERED/VIEWED/PARTIALLY_SIGNED/AWAITING_SIGNATURE) → COMPLETED`, with `DECLINED / CANCELLED / EXPIRED / VOIDED` as terminal outcomes and `ARCHIVED` after any terminal state. Transitions are enforced in `contracts/state-machine.ts` and unit-tested.

Sending locks the document version and freezes the field layout (DB triggers enforce this, not only application code). Finalisation stamps signatures onto the locked version, stores the final PDF, generates a completion certificate (with QR to the verification page) and records the SHA-256 of the source and final files.

## Coordinates

Fields are stored as fractions of the page CropBox in the *displayed* orientation, origin top-left, page index 0-based. `pdf-placement.test.ts` renders stamped PDFs at rotations 0/90/180/270 and checks the mark lands where the field was placed.
