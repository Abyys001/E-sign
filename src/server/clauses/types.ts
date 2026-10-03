import type { Condition } from "./condition";

export const CATEGORIES = [
  "PARTIES", "DEFINITIONS AND INTERPRETATION", "AGREEMENT STRUCTURE", "BILIT'S ROLE", "PROMOTER WARRANTIES", "EVENT", "EVENT DETAILS", "TICKETING",
  "BOOKING FEES", "PAYMENT PROCESSING", "SETTLEMENT", "ADVANCE PAYMENTS", "COMMERCIAL TERMS", "EXCLUSIVITY", "FINANCIAL",
  "CANCELLATION AND POSTPONEMENT", "ARTIST AND PERFORMER CHANGES", "REFUNDS", "REFUND AND CANCELLATION TERMS", "CHARGEBACKS", "CUSTOMER CLAIMS",
  "VENUE", "HEALTH AND SAFETY", "PRODUCTION", "MARKETING", "ARTIST",
  "COMPLIANCE", "INTELLECTUAL PROPERTY", "CONFIDENTIALITY", "DATA PROTECTION", "FRAUD, AML AND SANCTIONS", "INSURANCE", "INDEMNIFICATION", "LIMITATION OF LIABILITY",
  "WARRANTIES", "FORCE MAJEURE", "PROMOTER DEFAULT", "TERM AND TERMINATION", "TAX", "INTERNATIONAL EVENTS", "DISPUTES AND LAW", "ELECTRONIC EXECUTION",
  "CONTRACT ADMINISTRATION", "SPECIAL CONDITIONS", "GENERAL", "EXECUTION", "RECORDS",
] as const;
export type Category = (typeof CATEGORIES)[number];
export const MODULES = ["core", "ticketing", "venue", "production", "marketing", "staffing", "artist", "supplier", "event_day"] as const;
export type Module = (typeof MODULES)[number];

export type SeedVersion = { jurisdiction?: string; body: string; condition?: Condition };
export type SeedClause = { key: string; category: Category; module: Module; title: string; summary: string; versions: SeedVersion[] };

/** Terse constructor for library files. `body` may use {{variables}} from the registry or policy-derived variables. */
export const clause = (key: string, category: Category, module: Module, title: string, summary: string, body: string | SeedVersion[], condition?: Condition): SeedClause => ({
  key, category, module, title, summary,
  versions: typeof body === "string" ? [{ body, condition }] : body.map((v) => ({ ...v, condition: v.condition ?? condition })),
});
