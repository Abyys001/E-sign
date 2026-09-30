# Signing workflow

Generated contracts use the existing signing engine unchanged: sequential or parallel signers, per-signer verification (link, email OTP, SMS OTP, passcode, account), typed/drawn/uploaded signatures with consent, single-use tokens bound to a browser session, stamped PDF and a **completion certificate** with the final document hash.

Intake-specific parts:
- **Option A** builds recipients (organiser from the mapped name/email variables, Bilit signer from the form settings), places signature and date fields at the anchors produced during generation and calls `sendContract` with an idempotency key.
- **Option B/C** create nothing until staff act; *Approve and send for signature* re-checks formalities, records `contract.reviewed` and `contract.approved_for_signature`, then does the same as A.
- **Formalities:** if the policy needs a witness, deed, AES/QES etc. the send is refused with *"Additional execution formalities required."*.

After the last signature `finalizeContract` (idempotent, race-safe) produces the final PDF, certificate and audit summary. Public verification (`/verify/[id]`) checks the hash.
