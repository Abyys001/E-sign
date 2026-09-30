import { authed } from "@/server/http";
import { AGREEMENT_TYPES } from "@/server/agreements/types";
import { JURISDICTIONS } from "@/server/legal/jurisdictions";
import { REFUND_VARIANTS } from "@/server/policy/refund-engine";
import { BILIT_OBLIGATIONS, ORGANISER_OBLIGATIONS } from "@/server/policy/config";
import { BUILTIN_VARIABLES } from "@/server/variables/registry";
import { FIELD_PRESETS, FIELD_TYPES, WORKFLOW_LABEL } from "@/server/intake/schema";
import { LANGUAGES } from "@/server/agreements/service";
import { PLATFORM_CAPABILITIES } from "@/server/legal/signing-policy";
import { GENERIC_DISCLAIMER } from "@/server/legal/review-flags";

export const GET = authed("templates.view", async () => ({
  agreementTypes: AGREEMENT_TYPES.map((t) => ({ key: t.key, name: t.name, purpose: t.purpose, modules: t.modules, clauseCount: t.clauses.length })),
  jurisdictions: JURISDICTIONS.map(({ code, label, region, hasVariants, warnings }) => ({ code, label, region, hasVariants, warnings })),
  languages: LANGUAGES.map((code) => ({ code, label: code === "en" ? "English" : "فارسی" })), refundVariants: REFUND_VARIANTS, organiserObligations: ORGANISER_OBLIGATIONS, bilitObligations: BILIT_OBLIGATIONS,
  variables: BUILTIN_VARIABLES, fieldTypes: FIELD_TYPES, fieldPresets: FIELD_PRESETS, workflows: WORKFLOW_LABEL, platformCapabilities: PLATFORM_CAPABILITIES, disclaimer: GENERIC_DISCLAIMER,
}));
