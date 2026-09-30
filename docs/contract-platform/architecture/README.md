# Intake-driven contract generation: architecture

Chain: **template → clause selection → jurisdiction → intake form → secure email → organiser form → save draft → submit → contract generation → review or auto-send → e-signature → final PDF → completion certificate → audit → download → verification.**

> The platform produces drafting support. Generated contracts are **not** represented as legally compliant in any jurisdiction. Every generated contract carries legal-review flags, and the UI says: *"Template and legal configuration should be reviewed for the applicable jurisdiction and transaction."*

| Topic | Doc | Code |
|---|---|---|
| Contract intake | [contract-intake.md](contract-intake.md) | `src/server/intake/{schema,forms,invitations,public,process}.ts` |
| Template builder | [template-builder.md](template-builder.md) | `src/server/agreements/`, `src/components/intake/{form-builder,policy-editor,clause-selector}.tsx` |
| Clause library | [clause-library.md](clause-library.md) | `src/server/clauses/`, `src/server/variables/` |
| Legal / jurisdiction system | [legal-jurisdiction.md](legal-jurisdiction.md) | `src/server/legal/` |
| Refund policy engine | [refund-policy.md](refund-policy.md) | `src/server/policy/` |
| Contract generation | [contract-generation.md](contract-generation.md) | `src/server/generation/` |
| Email workflow | [email-workflow.md](email-workflow.md) | `src/server/messaging/` |
| Organiser workflow (public form + analytics) | [organiser-workflow.md](organiser-workflow.md) | `src/components/intake/intake-flow.tsx`, `src/server/intake/{public,telemetry,activity}.ts` |
| Signing workflow | [signing-workflow.md](signing-workflow.md) | `src/server/signing/`, `src/server/intake/process.ts` |
| Audit trail | [audit-trail.md](audit-trail.md) | `src/server/audit.ts` |

Stack: Next 16 App Router, Drizzle + Postgres, pg-boss, nodemailer, pdfkit + pdf-lib, next-intl (en/fa), zod 4, vitest on a real database.

## Design rules that apply everywhere
- **Immutability.** Clause versions, agreement template versions and intake form versions are frozen when published (DB triggers, not just app code). A change is a new version.
- **Server is the authority.** Client validation is convenience. Every answer, policy and signing decision is re-checked on the server.
- **Tokens are bearer secrets.** Intake and signing tokens are derived from `id + nonce` with an HMAC; only a hash is stored and the raw value exists only in the email. Revealing a link is an audited staff action.
- **No fake states.** Nothing is shown as delivered, signed, verified or compliant unless the system actually observed it (SMTP acceptance is `SENT`, never `DELIVERED`).
- **Tenant isolation.** Every query is scoped by `organisation_id`; every mutating route uses `authed(permission, …)`.
- **Queue + outbox.** Email, generation and reminders go through pg-boss, enqueued in the same transaction as the state change; sweepers recover anything stranded.

## Permissions added
`intake.view`, `intake.manage`, `intake.send`, `intake.telemetry` (IP / device detail). Approving clause text needs `settings.manage`.
