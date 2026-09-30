# Audit trail

`audit(tx, …)` writes an append-only, **hash-chained** record (per contract, or per organisation when there is no contract); `verifyAuditChain` re-computes the chain. Nothing is edited or deleted, and audit rows are written in the same transaction as the change.

Events added by this feature (contract chain unless noted):
- Library and templates (org): `clause_library.seeded`, `clause.draft_created`, `clause.published`, `clause.review_status_changed`, `agreement_template.created/published`.
- Intake (org): `intake.form.created/published/sent/viewed/returned/started/saved/submitted/reopened/revoked/expired`, `intake.link.accessed/revealed`, `intake.session.started`, `intake.otp.requested`, `intake.verified`, `intake.verification_failed`, `intake.file.uploaded`, `intake.reminder.sent`, `intake.generation_failed/retried`, `intake.telemetry.deleted`, `retention.intake_telemetry`.
- Contract: `contract.generated_from_intake`, `contract.jurisdiction.selected`, `contract.clauses.selected`, `contract.policy.selected`, `contract.refund_policy.selected`, `contract.exclusivity.selected`, `contract.legal_flags.raised`, `contract.auto_sent_from_intake`, `contract.auto_sign_halted`, `contract.reviewed`, `contract.approved_for_signature`, plus the existing sent/viewed/signed/completed events.
- Email: `email.sent/failed/suppressed/opened/bounced/complained`.

Audit metadata carries ids and counts, never secrets, tokens, OTPs or answer values. The unified timeline on an invitation joins email events, access events and contract events for display; it is a read model, not a second source of truth.
