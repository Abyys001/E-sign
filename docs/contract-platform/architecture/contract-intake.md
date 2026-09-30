# Contract intake

An **intake form** collects the facts a contract needs from the organiser. It is pinned to one published agreement template version, so the form can never ask for less than the clauses require.

## Form model (`src/server/intake/schema.ts`)
- 21 field types: text, long_text, email, phone, number, currency, date, time, datetime, dropdown, radio, checkbox, country, address, company, person, file, files, signature, initials, acknowledgement.
- Sections and fields with `required`, `visibleWhen` conditions, options, min/max/length/pattern, accepted file types.
- **Variable mapping.** Each field fills a contract variable (`variable`) or, for composite types, several (`variableMap`). Internal mappings are stripped before the schema is sent to the public page.
- **Coverage check.** `computeCoverage` compares the variables the selected clauses need against form fields, fixed values (`settings.fixedValues`), policy-derived values and automatic ones. A form with a missing variable cannot be published.
- **Workflow** (`A`–`D`) is part of the version — see [contract-generation.md](contract-generation.md).
- **Settings:** language, expiry days, notify emails, allow resume, privacy notice text, reminders (hours after send / before expiry), signers (workflow A), signing expiry.

## Lifecycle
`create → edit draft → validate → publish (frozen) → send invitations`. Editing a published form: *New version* copies it to a new draft; already-sent invitations keep the version they were sent with.

## Server-side validation
`validateAnswers(schema, answers, { final })` is the only source of truth. Drafts are validated leniently (types only); submit is strict (required, visibility-aware, unknown keys rejected, file references must belong to this submission). Hidden fields are pruned.

## Invitations (`invitations.ts`)
One invitation = one recipient = one unique link. Optional verification: none, **email one-time code**, or a **passcode** the sender shares by another channel (stored as an Argon2 hash). States: sent → delivered → viewed → started → saved → submitted, or revoked / expired. Staff can revoke, reopen a submitted form (audited, with reason) or copy the link (audited).

## Routes
Internal (`authed`): `/api/intake-forms`, `/api/intake-forms/[id]` (+ `new-version`, `invitations`, `access`, `sessions`, `devices`, `access-events`), `/api/intake-forms/versions/[vid]/{publish,preview}`, `/api/invitations/[id]/{activity,revoke,reopen,link,submission,retry-generation,telemetry}`, `/api/intake-files/[id]`.
Public (`open`): `/api/intake/[token]` and `/save`, `/submit`, `/beat`, `/verify`, `/upload`, `/files/[fileId]`.
