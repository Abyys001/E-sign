# Contract generation

`generateContract(tx, actor, { templateVersionId, values, source })` (`src/server/generation/service.ts`).

1. **Advisory lock + `generation_key`** (`intake:<submission>:<rev>` or manual) — `contracts.generation_key` is unique, so a retry can never create a second contract.
2. Load the pinned clause versions, derive policy variables (authoritative over intake answers), merge answers.
3. `composeClauses` → numbered sections; **fail with every problem listed** if any variable is unresolved or required data is missing (`GenerationError`).
4. `computeLegalFlags` + `evaluateSigningPolicy`.
5. `renderAgreementPdf` (pdfkit) → bytes, page count and signature/date anchors on the last page.
6. `addContractVersion` (existing path: hashing, locking) and store the **manifest**: template version, exact clause version ids, variables, policy, jurisdiction, document hash, anchors, input hashes. `contracts.intake_submission_id` links back to the submission.

Workflows (`process.ts`, run by the `intake.process` queue):
| | Result |
|---|---|
| **A** | Generate → create organiser + Bilit recipients and signature/date fields at the anchors → send for e-signature. Halts (no send) if formalities are required. |
| **B** | Generate a **draft**; staff review, then *Approve and send for signature* (`/api/contracts/[id]/approve-for-signature`). |
| **C** | Generate the PDF, mark ready; staff send it themselves (any channel). |
| **D** | Store the submission only. |
Generation errors that retrying cannot fix set `generationStatus = FAILED` with the error, notify staff and wait for an explicit *Retry*; transient errors retry via pg-boss. `sweepIntake` re-queues stuck jobs. The invitation detail shows the real state (queued / generating / failed / halted / done).
