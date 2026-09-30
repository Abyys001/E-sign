import { z } from "zod";

/** Contract variable registry: the only names a clause, form field or email may reference. */
export const VARIABLE_TYPES = ["text", "longtext", "email", "phone", "number", "currency", "percent", "date", "time", "boolean", "select", "country"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const VariableDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().min(1).max(120),
  type: z.enum(VARIABLE_TYPES).default("text"),
  group: z.string().max(40).default("custom"),
  options: z.array(z.string().max(120)).max(50).optional(),
});
export type VariableDef = z.infer<typeof VariableDef>;

const v = (key: string, label: string, type: VariableType, group: string, options?: string[]): VariableDef => ({ key, label, type, group, options });

/** Built-in variables. Organisations extend this with custom keys on the template version. */
export const BUILTIN_VARIABLES: VariableDef[] = [
  v("organisation_name", "Bilit organisation name", "text", "parties"),
  v("organisation_address", "Bilit organisation address", "longtext", "parties"),
  v("organiser_name", "Organiser representative", "text", "parties"),
  v("organiser_title", "Organiser representative title", "text", "parties"),
  v("organiser_company", "Organiser legal entity", "text", "parties"),
  v("organiser_registration_number", "Organiser registration number", "text", "parties"),
  v("organiser_address", "Organiser address", "longtext", "parties"),
  v("organiser_email", "Organiser email", "email", "parties"),
  v("organiser_phone", "Organiser phone", "phone", "parties"),
  v("event_name", "Event name", "text", "event"),
  v("event_date", "Event date", "date", "event"),
  v("event_time", "Event start time", "time", "event"),
  v("event_venue", "Venue", "text", "event"),
  v("event_city", "City", "text", "event"),
  v("event_country", "Country", "country", "event"),
  v("event_type", "Event type", "text", "event"),
  v("event_capacity", "Capacity", "number", "event"),
  v("ticket_inventory", "Ticket inventory covered", "number", "ticketing"),
  v("ticket_price", "Ticket price", "currency", "financial"),
  v("currency", "Currency", "text", "financial"),
  v("booking_fee", "Booking fee", "currency", "financial"),
  v("payment_processing_fee", "Payment-processing fee", "currency", "financial"),
  v("commission", "Commission", "percent", "financial"),
  v("settlement_days", "Settlement days after event", "number", "financial"),
  v("reserve_percent", "Rolling reserve", "percent", "financial"),
  v("refund_deadline", "Refund deadline", "date", "refunds"),
  v("refund_window_days", "Refund window (days)", "number", "refunds"),
  v("effective_date", "Effective date", "date", "contract"),
  v("governing_law", "Governing law", "text", "legal"),
  v("jurisdiction", "Jurisdiction / courts", "text", "legal"),
  v("agreement_title", "Agreement title", "text", "contract"),
  v("support_email", "Bilit support email", "email", "contract"),
];

export const VARIABLE_RE = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;

export const findVariables = (text: string): string[] => [...new Set([...text.matchAll(VARIABLE_RE)].map((m) => m[1]!))];

export type VariableValues = Record<string, unknown>;

const isBlank = (x: unknown) => x === undefined || x === null || (typeof x === "string" && x.trim() === "");

/** Display form of a raw value. Dates keep ISO ("YYYY-MM-DD") input and render as an unambiguous long form. */
export function formatValue(def: VariableDef | undefined, raw: unknown): string {
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  const s = String(raw).trim();
  if (def?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${s}T00:00:00Z`));
  if (def?.type === "percent" && /^-?\d+(\.\d+)?$/.test(s)) return `${s}%`;
  return s;
}

/** Variables referenced by `text` that have no value. Optional ones may be an explicit empty string; nothing may be undefined. */
export const unresolvedIn = (text: string, values: VariableValues, optional: ReadonlySet<string> = new Set()): string[] =>
  findVariables(text).filter((k) => values[k] === undefined || values[k] === null || (isBlank(values[k]) && !optional.has(k)));

export class UnresolvedVariablesError extends Error {
  constructor(public missing: string[]) {
    super(`Unresolved variables: ${missing.join(", ")}`);
  }
}

/** Validate a value against its declared type; returns an error message or null. */
export function validateValue(def: VariableDef, raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const s = String(raw).trim();
  switch (def.type) {
    case "email": return z.email().safeParse(s).success ? null : "must be a valid email";
    case "phone": return /^\+?[0-9 ()\-.]{6,24}$/.test(s) ? null : "must be a valid phone number";
    case "number": case "currency": case "percent": return /^-?\d+(\.\d+)?$/.test(s) ? null : "must be a number";
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? null : "must be a date (YYYY-MM-DD)";
    case "time": return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? null : "must be a time (HH:MM)";
    case "select": return def.options?.includes(s) ? null : "must be one of the allowed options";
    case "boolean": return typeof raw === "boolean" || s === "true" || s === "false" ? null : "must be true or false";
    default: return s.length <= 5000 ? null : "is too long";
  }
}

/**
 * Substitute {{vars}} in `text`. Throws UnresolvedVariablesError if any referenced variable has no value —
 * a final contract must never contain a raw placeholder. Output is plain text (PDF), so no HTML escaping.
 */
export function renderText(text: string, values: VariableValues, defs: VariableDef[] = BUILTIN_VARIABLES, optional: ReadonlySet<string> = new Set()): string {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const missing = unresolvedIn(text, values, optional);
  if (missing.length) throw new UnresolvedVariablesError(missing);
  return text.replace(VARIABLE_RE, (_, k: string) => formatValue(byKey.get(k), values[k]));
}

export const mergeDefs = (custom: VariableDef[] = []): VariableDef[] => {
  const m = new Map(BUILTIN_VARIABLES.map((d) => [d.key, d]));
  for (const c of custom) m.set(c.key, c);
  return [...m.values()];
};
