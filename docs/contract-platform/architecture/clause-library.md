# Clause library

`src/server/clauses/` · seed content in `library/{core,ticketing,services,legal}.ts` (about 90 English clauses).

- **Clause** = stable key (`refunds.variant.A`, `exclusivity.grant`, …), category, module. **Clause version** = immutable text for one jurisdiction and language, with status `DRAFT | PUBLISHED | RETIRED` and `review_status` `unreviewed | in_review | approved`. Published rows cannot be updated or deleted (trigger `esign_guard_clause_version`).
- **Variants.** A clause can have several jurisdiction variants (`ANY`, `UK`, `EU`, `AE`, `US`, or an exact code). `pickVariant` scores exact > region > prefix > `ANY`, latest version wins.
- **Conditions.** A JSON condition (`all/any/not/eq/ne/in/truthy/gt/lt`) decides whether a clause is included, so unselected obligations are never invented.
- **Variables** (`src/server/variables/registry.ts`): typed placeholders `{{organiser_name}}`. Rendering fails loudly (`UnresolvedVariablesError`) if anything is left unresolved; optional variables may be an explicit empty string.
- **Review status** is a human decision (needs `settings.manage`). Seed clauses ship as `unreviewed`; publishing a template that uses them raises the `clauses.unreviewed` flag.
- English only for now. Persian is supported in UI/schema, but no Persian clause text exists.

Compare/diff between versions and clause authoring UI are API-only (`POST /api/clauses/versions`, `PATCH …/[id]`, `…/publish`); the library page is read + review.
