import { z } from "zod";
import { ConditionSchema, evaluate, type Condition } from "../clauses/condition";

export const FIELD_TYPES = [
  "text", "long_text", "email", "phone", "number", "currency", "date", "time", "datetime", "dropdown", "radio", "checkbox",
  "country", "address", "company", "person", "file", "files", "signature", "initials", "acknowledgement",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const VarKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const FieldDef = z.object({
  key: Key,
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1).max(200),
  help: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().default(false),
  default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string().min(1).max(120), label: z.string().min(1).max(200) })).max(100).optional(),
  min: z.number().optional(), max: z.number().optional(),
  minLength: z.number().int().min(0).max(5000).optional(), maxLength: z.number().int().min(1).max(5000).optional(),
  pattern: z.string().max(200).optional(),
  accept: z.array(z.enum(["pdf", "png", "jpg", "docx"])).optional(),
  maxFiles: z.number().int().min(1).max(20).optional(),
  visibleWhen: ConditionSchema.optional(),
  /** Scalar fields map their value to one contract variable. */
  variable: VarKey.optional(),
  /** Composite fields (person/company/address) map each sub-value to a variable: {name: "organiser_name"}. */
  variableMap: z.record(z.string(), VarKey).optional(),
  /** Text shown for legal acknowledgements. */
  acknowledgement: z.string().max(2000).optional(),
  preset: z.string().max(60).optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const SectionDef = z.object({
  key: Key,
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  visibleWhen: ConditionSchema.optional(),
  fields: z.array(FieldDef).max(80),
});
export type SectionDef = z.infer<typeof SectionDef>;

export const FormSchema = z.object({ sections: z.array(SectionDef).min(1).max(30) }).superRefine((f, ctx) => {
  const seen = new Set<string>();
  const secs = new Set<string>();
  for (const [i, s] of f.sections.entries()) {
    if (secs.has(s.key)) ctx.addIssue({ code: "custom", path: ["sections", i, "key"], message: `Duplicate section key "${s.key}"` });
    secs.add(s.key);
    for (const [j, fld] of s.fields.entries()) {
      if (seen.has(fld.key)) ctx.addIssue({ code: "custom", path: ["sections", i, "fields", j, "key"], message: `Duplicate field key "${fld.key}"` });
      seen.add(fld.key);
      if (["dropdown", "radio"].includes(fld.type) && !fld.options?.length) ctx.addIssue({ code: "custom", path: ["sections", i, "fields", j, "options"], message: "Options required" });
      if (fld.variable && fld.variableMap) ctx.addIssue({ code: "custom", path: ["sections", i, "fields", j], message: "Use either variable or variableMap" });
      if (fld.pattern) { try { new RegExp(fld.pattern); } catch { ctx.addIssue({ code: "custom", path: ["sections", i, "fields", j, "pattern"], message: "Invalid pattern" }); } }
    }
  }
});
export type FormSchema = z.infer<typeof FormSchema>;

export const FormSettings = z.object({
  description: z.string().max(2000).default(""),
  language: z.enum(["en", "fa"]).default("en"),
  branding: z.object({ displayName: z.string().max(120).optional(), logoObjectId: z.string().uuid().nullish(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).default({}),
  expiryDays: z.number().int().min(1).max(180).default(30),
  notifyEmails: z.array(z.email()).max(10).default([]),
  privacyNotice: z.object({ enabled: z.boolean().default(true), text: z.string().max(2000).default("We record technical access information (such as IP address, browser and device type, and the times you open and use this form) to keep this form secure and to let the sender know its progress. This is not used to identify you beyond that. See the sender's privacy notice for details.") }).default({ enabled: true, text: "We record technical access information (such as IP address, browser and device type, and the times you open and use this form) to keep this form secure and to let the sender know its progress. This is not used to identify you beyond that. See the sender's privacy notice for details." }),
  reminders: z.object({ afterHours: z.array(z.number().int().min(1).max(24 * 60)).max(5).default([]), beforeExpiryHours: z.array(z.number().int().min(1).max(24 * 60)).max(5).default([]) }).default({ afterHours: [], beforeExpiryHours: [] }),
  allowResume: z.boolean().default(true),
  /** Known values Bilit supplies for the contract (not asked of the organiser). */
  fixedValues: z.record(VarKey, z.string().max(2000)).default({}),
  /** Who signs when the workflow creates a signing request. */
  signers: z.object({
    organiser: z.object({ nameVariable: VarKey.default("organiser_name"), emailVariable: VarKey.default("organiser_email") }).default({ nameVariable: "organiser_name", emailVariable: "organiser_email" }),
    bilit: z.object({ name: z.string().max(200), email: z.email() }).optional(),
    order: z.enum(["organiser_first", "bilit_first"]).default("organiser_first"),
  }).default({ organiser: { nameVariable: "organiser_name", emailVariable: "organiser_email" }, order: "organiser_first" }),
  signingExpiryDays: z.number().int().min(1).max(180).default(30),
  emailTemplate: z.object({ message: z.string().max(2000).optional() }).default({}),
});
export type FormSettings = z.infer<typeof FormSettings>;

export const WORKFLOWS = ["A", "B", "C", "D"] as const;
export type Workflow = (typeof WORKFLOWS)[number];
export const WORKFLOW_LABEL: Record<Workflow, string> = {
  A: "Automatically generate contract and send for electronic signature",
  B: "Generate contract and save as draft for review",
  C: "Generate PDF and allow Bilit staff to send manually",
  D: "Save submitted information only; create contract manually",
};

export type Answers = Record<string, unknown>;
export type FieldProblem = { key: string; message: string };

const ISO_COUNTRY = /^[A-Z]{2}$/;
const isDateStr = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const str = (v: unknown, max = 5000) => (typeof v === "string" && v.length <= max ? v.trim() : null);

export const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export function allFields(schema: FormSchema) { return schema.sections.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.key }))); }

/** Which fields/sections apply given the answers so far (conditional visibility is evaluated server-side, never trusted from the client). */
export function visibility(schema: FormSchema, answers: Answers) {
  const ctx = flatten(answers);
  const sections = new Map<string, boolean>();
  const fields = new Map<string, boolean>();
  for (const s of schema.sections) {
    const sv = evaluate(s.visibleWhen as Condition | undefined, ctx);
    sections.set(s.key, sv);
    for (const f of s.fields) fields.set(f.key, sv && evaluate(f.visibleWhen as Condition | undefined, ctx));
  }
  return { sections, fields };
}

/** Conditions reference field keys; composite answers are addressable as `key.sub`. */
const flatten = (a: Answers): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    out[k] = v;
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [sk, sv] of Object.entries(v)) out[`${k}.${sk}`] = sv;
  }
  return out;
};

/** Validate one value against its field definition; returns an error message or null. Server-side only source of truth. */
export function validateFieldValue(f: FieldDef, v: unknown): string | null {
  if (isBlank(v)) return null;
  const len = (s: string) => (f.minLength && s.length < f.minLength ? `must be at least ${f.minLength} characters` : f.maxLength && s.length > f.maxLength ? `must be at most ${f.maxLength} characters` : f.pattern && !new RegExp(f.pattern).test(s) ? "has an invalid format" : null);
  switch (f.type) {
    case "text": case "long_text": { const s = str(v, f.type === "text" ? 500 : 5000); return s === null ? "must be text" : len(s); }
    case "email": { const s = str(v, 254); return s && z.email().safeParse(s).success ? null : "must be a valid email address"; }
    case "phone": { const s = str(v, 30); return s && /^\+?[0-9 ()\-.]{6,24}$/.test(s) ? null : "must be a valid phone number"; }
    case "number": case "currency": {
      const s = typeof v === "number" ? String(v) : str(v, 30);
      if (!s || !/^-?\d+(\.\d{1,6})?$/.test(s)) return "must be a number";
      const n = Number(s);
      if (f.type === "currency" && n < 0) return "must not be negative";
      return f.min !== undefined && n < f.min ? `must be at least ${f.min}` : f.max !== undefined && n > f.max ? `must be at most ${f.max}` : null;
    }
    case "date": { const s = str(v, 10); return s && isDateStr(s) ? null : "must be a date (YYYY-MM-DD)"; }
    case "time": { const s = str(v, 5); return s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? null : "must be a time (HH:MM)"; }
    case "datetime": { const s = str(v, 32); return s && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d/.test(s) && !Number.isNaN(Date.parse(s)) ? null : "must be a date and time"; }
    case "dropdown": case "radio": { const s = str(v, 120); return s && f.options?.some((o) => o.value === s) ? null : "must be one of the listed options"; }
    case "checkbox": return typeof v === "boolean" ? null : "must be true or false";
    case "acknowledgement": return v === true ? null : "must be accepted";
    case "country": { const s = str(v, 2); return s && ISO_COUNTRY.test(s) ? null : "must be a 2-letter country code"; }
    case "person": {
      const o = v as Record<string, unknown>;
      if (typeof o !== "object" || o === null) return "must be a person";
      if (!str(o.name, 200)) return "needs a name";
      if (!str(o.email, 254) || !z.email().safeParse(o.email).success) return "needs a valid email";
      return o.phone && !/^\+?[0-9 ()\-.]{6,24}$/.test(String(o.phone)) ? "has an invalid phone number" : null;
    }
    case "company": {
      const o = v as Record<string, unknown>;
      if (typeof o !== "object" || o === null) return "must be a company";
      if (!str(o.name, 200)) return "needs a company name";
      return o.country && !ISO_COUNTRY.test(String(o.country)) ? "has an invalid country" : null;
    }
    case "address": {
      const o = v as Record<string, unknown>;
      if (typeof o !== "object" || o === null) return "must be an address";
      if (!str(o.line1, 200) || !str(o.city, 120)) return "needs a street line and a city";
      return !o.country || !ISO_COUNTRY.test(String(o.country)) ? "needs a country" : null;
    }
    case "file": return typeof v === "object" && v !== null && typeof (v as { fileId?: unknown }).fileId === "string" ? null : "must be an uploaded file";
    case "files": return Array.isArray(v) && v.length <= (f.maxFiles ?? 5) && v.every((x) => typeof x?.fileId === "string") ? null : "must be uploaded files";
    case "signature": case "initials": {
      const o = v as { kind?: string; text?: string; dataUrl?: string };
      if (o?.kind === "typed") return str(o.text, 120) ? null : "needs a typed name";
      if (o?.kind === "drawn") return typeof o.dataUrl === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(o.dataUrl) && o.dataUrl.length < 400_000 ? null : "has an invalid drawing";
      return "must be typed or drawn";
    }
  }
}

export type ValidationResult = { ok: boolean; problems: FieldProblem[]; unknownKeys: string[] };

/**
 * Validate answers. `final: false` (autosave) only checks that supplied values are well-formed; `final: true` (submit)
 * also enforces required fields for everything currently visible. Hidden fields' answers are rejected as unknown context.
 */
export function validateAnswers(schema: FormSchema, answers: Answers, opts: { final: boolean }): ValidationResult {
  const fields = allFields(schema);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const vis = visibility(schema, answers);
  const problems: FieldProblem[] = [];
  const unknownKeys = Object.keys(answers).filter((k) => !byKey.has(k));
  for (const f of fields) {
    const visible = vis.fields.get(f.key) ?? false;
    const v = answers[f.key];
    if (!visible) continue;
    if (opts.final && f.required && isBlank(v)) { problems.push({ key: f.key, message: `${f.label} is required` }); continue; }
    const err = validateFieldValue(f, v);
    if (err) problems.push({ key: f.key, message: `${f.label} ${err}` });
  }
  return { ok: !problems.length && !unknownKeys.length, problems, unknownKeys };
}

/** Drop answers to hidden fields (they never feed a contract). */
export function pruneHidden(schema: FormSchema, answers: Answers): Answers {
  const vis = visibility(schema, answers);
  return Object.fromEntries(Object.entries(answers).filter(([k]) => vis.fields.get(k) !== false));
}

/** Map validated answers onto contract variables via each field's variable mapping. */
export function answersToVariables(schema: FormSchema, answers: Answers): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const vis = visibility(schema, answers);
  for (const f of allFields(schema)) {
    if (!vis.fields.get(f.key)) continue;
    const v = answers[f.key];
    if (isBlank(v)) continue;
    if (f.variable) out[f.variable] = typeof v === "object" && !Array.isArray(v) ? undefined : v;
    if (f.variableMap && v && typeof v === "object") for (const [sub, variable] of Object.entries(f.variableMap)) { const sv = (v as Record<string, unknown>)[sub]; if (!isBlank(sv)) out[variable] = sv; }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** Share of visible fields that have an answer, weighted equally; also per section. Never exposes the answers themselves. */
export function progress(schema: FormSchema, answers: Answers) {
  const vis = visibility(schema, answers);
  const sections = schema.sections.filter((s) => vis.sections.get(s.key)).map((s) => {
    const fs = s.fields.filter((f) => vis.fields.get(f.key));
    const done = fs.filter((f) => !isBlank(answers[f.key])).length;
    return { key: s.key, title: s.title, total: fs.length, done, status: done === 0 ? "not_started" : done === fs.length ? "completed" : "in_progress" } as const;
  });
  const total = sections.reduce((n, s) => n + s.total, 0);
  const done = sections.reduce((n, s) => n + s.done, 0);
  return { percent: total ? Math.round((done / total) * 100) : 0, total, done, sections };
}

/** Field presets the builder offers (organisation, event, ticketing...). Keys are variable names so mapping is automatic. */
export const FIELD_PRESETS: Record<string, FieldDef> = {
  organiser_company: FieldDef.parse({ key: "organiser_company_details", type: "company", label: "Organisation", required: true, variableMap: { name: "organiser_company", registrationNumber: "organiser_registration_number", country: "event_country" }, preset: "organiser_company" }),
  organiser_person: FieldDef.parse({ key: "organiser_contact", type: "person", label: "Authorised signatory", required: true, variableMap: { name: "organiser_name", email: "organiser_email", phone: "organiser_phone" }, preset: "organiser_person" }),
  organiser_address: FieldDef.parse({ key: "organiser_address_field", type: "address", label: "Registered address", required: true, preset: "organiser_address" }),
  event_name: FieldDef.parse({ key: "event_name", type: "text", label: "Event name", required: true, variable: "event_name", preset: "event_name" }),
  event_date: FieldDef.parse({ key: "event_date", type: "date", label: "Event date", required: true, variable: "event_date", preset: "event_date" }),
  event_time: FieldDef.parse({ key: "event_time", type: "time", label: "Start time", required: true, variable: "event_time", preset: "event_time" }),
  event_venue: FieldDef.parse({ key: "event_venue", type: "text", label: "Venue", required: true, variable: "event_venue", preset: "event_venue" }),
  event_city: FieldDef.parse({ key: "event_city", type: "text", label: "City", required: true, variable: "event_city", preset: "event_city" }),
  event_country: FieldDef.parse({ key: "event_country", type: "text", label: "Country", required: true, variable: "event_country", preset: "event_country" }),
  ticket_price: FieldDef.parse({ key: "ticket_price", type: "currency", label: "Base ticket price", required: true, variable: "ticket_price", preset: "ticket_price" }),
  ticket_inventory: FieldDef.parse({ key: "ticket_inventory", type: "number", label: "Ticket inventory", required: true, min: 1, variable: "ticket_inventory", preset: "ticket_inventory" }),
};
