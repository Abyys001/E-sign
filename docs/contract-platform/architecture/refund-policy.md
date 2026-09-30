# Refund policy engine

`src/server/policy/refund-engine.ts` — a pure function `evaluateRefund({ reason, jurisdiction, rules })`.

**Hierarchy** (first match wins): law → consumer rights → contract → ticket terms → Bilit default. The decision lists its provenance so a reviewer can see *why*.

**Default label:** `Default Bilit Policy: Booking Fee Non-Refundable`. It is a contractual/product policy and is **never described as "by law"**.

Outputs per reason: ticket, booking fee, processing fee, taxes, shipping, who bears chargeback fees, who funds the refund, settlement reversal, deadline, partial refunds, reschedule treatment. 13 reasons (organiser cancellation, postponement, reschedule, venue change, lineup change, customer request, duplicate purchase, fraud, force majeure, …).

**Variants A–H** are selectable contract clauses (`refunds.variant.*`); `variantRules` turns the chosen variant, deadline and funding party into rules. Extra rules (`overrides`) can layer law/consumer-rights rules on top. The variant, the resolved decision and the money-flow configuration are stored in the generation manifest.

Related configs: `exclusivity.ts` (configurable **contractual** exclusivity: scope, inventory, channels, exceptions, territory, dates, breach consequences — never presented as law) and `money-flow.ts` (who collects, holds, processes, settles, refunds; booking fee, commission, taxes, chargebacks, reserve, settlement timing). Nothing is assumed by default.
