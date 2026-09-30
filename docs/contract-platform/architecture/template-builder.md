# Template builder

Two builders, both under **Templates**:

## Contract templates (`/templates/agreements`)
An *agreement template* is a named composition of clauses for one agreement type, jurisdiction and language, plus a **policy configuration**. Five agreement types are provided as compositions of shared clauses: `ticketing_distribution`, `venue_production`, `marketing_promotional`, `full_event_management`, `cancellation_refund` (`src/server/agreements/types.ts`).

The editor has:
- **Clause selector** (search, category filter, select all/none, per-clause version pin, preview, review status).
- **Policy panel:** refund variant A–H, exclusivity, money flow, organiser/Bilit obligations (*only ticked obligations are emitted*), execution formalities, liability cap.
- **Legal flags** and warnings (never blocking), **money-flow summary**, and the list of variables the form must collect.
- Changing jurisdiction re-pins every selected clause to that jurisdiction's variant on the server.
- Publish validates and freezes the version (`esign_guard_published_version` trigger).

## Intake forms (`/templates/intake/[id]`)
Three-pane builder: structure (sections/fields, up/down reordering, standard-field presets) · live preview · properties (label, key, type, required, help, options, variable mapping) with a form-settings block. Tabs: **Builder**, **Invitations**, **Access & activity**. *What will be generated* shows template, jurisdiction, workflow, refund/exclusivity/money summary, signers and legal flags before you publish.

Not built: free-form drag-and-drop (reordering is up/down buttons), side-by-side clause diff, per-field conditional-logic editor (conditions are supported by the schema and evaluated server- and client-side but authored as JSON only).
