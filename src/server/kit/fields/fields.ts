import { z } from 'zod';

/** Same shape as backend/pdf/src/field-coordinates.ts RelativeRect (fractions of the visible page, top-left origin). */
export const RelativeRectSchema = z
  .object({
    page: z.number().int().min(0),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((r) => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, 'rect exceeds page bounds');

const ConditionSchema = z.object({
  fieldId: z.string().min(1),
  op: z.enum(['eq', 'neq', 'filled', 'empty', 'checked', 'unchecked']),
  value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
});
export type VisibilityCondition = z.infer<typeof ConditionSchema>;

const Base = {
  id: z.string().min(1).max(64),
  recipientId: z.string().min(1).max(64),
  rect: RelativeRectSchema,
  required: z.boolean().default(true),
  /** Optimistic-lock counter for the field definition while the contract is a draft. */
  version: z.number().int().min(1).default(1),
  /** All conditions must hold (AND) for the field to be shown/required. */
  visibleWhen: z.array(ConditionSchema).max(10).default([]),
  label: z.string().max(200).optional(),
  /**
   * Calculated-field hook: name of a registered calculator plus the field ids it reads. The engine that evaluates it is
   * product-specific (see README); a calculated field is read-only for the signer and never trusted from the client.
   */
  calculated: z.object({ calculator: z.string().min(1).max(64), inputs: z.array(z.string()).max(20) }).optional(),
};

const text = (max: number) => z.string().max(max);

export const FieldSchema = z.discriminatedUnion('type', [
  z.object({ ...Base, type: z.literal('signature') }),
  z.object({ ...Base, type: z.literal('initials') }),
  z.object({ ...Base, type: z.literal('text'), maxLength: z.number().int().min(1).max(500).default(200), pattern: z.string().max(200).optional() }),
  z.object({ ...Base, type: z.literal('long_text'), maxLength: z.number().int().min(1).max(5000).default(2000) }),
  z.object({ ...Base, type: z.literal('email') }),
  z.object({ ...Base, type: z.literal('phone') }),
  z.object({ ...Base, type: z.literal('date'), min: z.string().optional(), max: z.string().optional() }),
  z.object({ ...Base, type: z.literal('datetime') }),
  z.object({ ...Base, type: z.literal('checkbox') }),
  z.object({ ...Base, type: z.literal('radio'), options: z.array(text(200)).min(2).max(50) }),
  z.object({ ...Base, type: z.literal('dropdown'), options: z.array(text(200)).min(1).max(200) }),
  z.object({ ...Base, type: z.literal('number'), min: z.number().optional(), max: z.number().optional(), decimals: z.number().int().min(0).max(6).default(0) }),
  z.object({ ...Base, type: z.literal('currency'), currency: z.string().regex(/^[A-Z]{3}$/), min: z.number().optional(), max: z.number().optional() }),
  z.object({ ...Base, type: z.literal('company'), maxLength: z.number().int().min(1).max(200).default(200) }),
  z.object({ ...Base, type: z.literal('job_title'), maxLength: z.number().int().min(1).max(200).default(200) }),
  z.object({ ...Base, type: z.literal('attachment'), maxBytes: z.number().int().min(1).max(25 * 1024 * 1024).default(10 * 1024 * 1024), allowedMime: z.array(z.string()).default(['application/pdf', 'image/png', 'image/jpeg']) }),
]);
export type Field = z.infer<typeof FieldSchema>;
export type FieldInput = z.input<typeof FieldSchema>;
export type FieldType = Field['type'];

export const parseField = (input: unknown): Field => FieldSchema.parse(input);

/**
 * Field values. Signature/initials carry a reference to server-stored evidence (backend/signatures), never raw image data:
 * the client cannot mark a signature "done" by sending arbitrary content.
 */
export type FieldValue =
  | { kind: 'text'; text: string }
  | { kind: 'bool'; checked: boolean }
  | { kind: 'signature'; evidenceId: string }
  | { kind: 'attachment'; storageKey: string; bytes: number; mime: string };

export type ValidationResult = { ok: true } | { ok: false; code: string };
const ok: ValidationResult = { ok: true };
const bad = (code: string): ValidationResult => ({ ok: false, code });

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;
const PHONE_E164 = /^\+[1-9]\d{6,14}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function validDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Decimal string check avoids float artefacts: "0.1" with decimals=1 is fine, "0.15" is not. */
function decimalPlaces(s: string): number {
  return s.split('.')[1]?.length ?? 0;
}

function numeric(s: string, min: number | undefined, max: number | undefined, decimals: number): ValidationResult {
  if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(s)) return bad('invalid_number');
  if (decimalPlaces(s) > decimals) return bad('too_many_decimals');
  const n = Number(s);
  if (min !== undefined && n < min) return bad('below_min');
  if (max !== undefined && n > max) return bad('above_max');
  return ok;
}

/** Text values are stored and rendered as data; this rejects control characters but does NOT escape. Escape at output (PDF stamping / HTML). */
function plain(value: FieldValue, max: number): ValidationResult | string {
  if (value.kind !== 'text') return bad('wrong_value_kind');
  if (value.text.length > max) return bad('too_long');
  if (CONTROL.test(value.text)) return bad('control_characters');
  return value.text;
}

export function validateFieldValue(field: Field, value: FieldValue): ValidationResult {
  switch (field.type) {
    case 'signature':
    case 'initials':
      return value.kind === 'signature' && value.evidenceId.length > 0 ? ok : bad('wrong_value_kind');
    case 'checkbox':
      return value.kind === 'bool' ? ok : bad('wrong_value_kind');
    case 'attachment': {
      if (value.kind !== 'attachment') return bad('wrong_value_kind');
      if (value.bytes > field.maxBytes) return bad('too_large');
      return field.allowedMime.includes(value.mime) ? ok : bad('mime_not_allowed');
    }
    default:
  }
  const max = 'maxLength' in field ? field.maxLength : 500;
  const t = plain(value, field.type === 'email' ? 320 : field.type === 'long_text' ? field.maxLength : max);
  if (typeof t !== 'string') return t;
  const s = t.trim();
  if (s === '') return bad('empty');
  switch (field.type) {
    case 'text':
      if (field.pattern) {
        // Patterns come from the sender, not the signer; still bound the input length above to limit ReDoS exposure.
        try { if (!new RegExp(field.pattern).test(s)) return bad('pattern_mismatch'); } catch { return bad('invalid_pattern'); }
      }
      return ok;
    case 'email': return EMAIL.test(s) ? ok : bad('invalid_email');
    case 'phone': return PHONE_E164.test(s.replace(/[\s()-]/g, '')) ? ok : bad('invalid_phone');
    case 'date': {
      if (!validDate(s)) return bad('invalid_date');
      if (field.min && s < field.min) return bad('below_min');
      if (field.max && s > field.max) return bad('above_max');
      return ok;
    }
    case 'datetime': return ISO_DATETIME.test(s) && !Number.isNaN(Date.parse(s)) ? ok : bad('invalid_datetime');
    case 'radio':
    case 'dropdown': return field.options.includes(s) ? ok : bad('not_an_option');
    case 'number': return numeric(s, field.min, field.max, field.decimals);
    case 'currency': return numeric(s, field.min, field.max, 2);
    default: return ok; // long_text, company, job_title: length + control-char checks above
  }
}

export type Values = Readonly<Record<string, FieldValue | undefined>>;

function isFilled(v: FieldValue | undefined): boolean {
  if (!v) return false;
  if (v.kind === 'text') return v.text.trim() !== '';
  if (v.kind === 'bool') return true;
  return true;
}

function conditionHolds(c: VisibilityCondition, values: Values): boolean {
  const v = values[c.fieldId];
  switch (c.op) {
    case 'filled': return isFilled(v);
    case 'empty': return !isFilled(v);
    case 'checked': return v?.kind === 'bool' && v.checked;
    case 'unchecked': return !(v?.kind === 'bool' && v.checked);
    case 'eq': return v?.kind === 'text' && v.text === String(c.value);
    case 'neq': return !(v?.kind === 'text' && v.text === String(c.value));
  }
}

export function evaluateVisibility(field: Field, values: Values): boolean {
  return field.visibleWhen.every((c) => conditionHolds(c, values));
}

/**
 * Completion gate: required, currently visible fields for `recipientId` with no valid value.
 * Hidden fields never block, and their stale values must be dropped by the caller before sealing.
 * Checkbox: required means "must be checked" (consent-style); an unchecked value counts as missing.
 */
export function missingRequiredFields(fields: readonly Field[], values: Values, recipientId?: string): Field[] {
  return fields.filter((f) => {
    if (recipientId && f.recipientId !== recipientId) return false;
    if (!f.required || !evaluateVisibility(f, values)) return false;
    const v = values[f.id];
    if (!isFilled(v)) return true;
    if (f.type === 'checkbox') return !(v?.kind === 'bool' && v.checked);
    return !validateFieldValue(f, v!).ok;
  });
}
