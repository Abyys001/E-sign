export const FIELD_TYPES = ["signature", "initials", "text", "long_text", "email", "phone", "date", "datetime", "checkbox", "radio", "dropdown", "number", "currency", "company", "job_title", "attachment"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type EditorField = {
  id: string; partyId: string; type: FieldType; label: string; required: boolean;
  page: number; x: number; y: number; w: number; h: number;
  options: string[]; extras: Record<string, unknown>; defaultValue: string;
};

/** Default box size as a fraction of the page (A4-ish proportions). */
export const DEFAULT_SIZE: Record<FieldType, [number, number]> = {
  signature: [0.26, 0.06], initials: [0.11, 0.05], text: [0.26, 0.028], long_text: [0.4, 0.09], email: [0.28, 0.028], phone: [0.22, 0.028], date: [0.16, 0.028], datetime: [0.2, 0.028],
  checkbox: [0.028, 0.02], radio: [0.24, 0.05], dropdown: [0.24, 0.028], number: [0.16, 0.028], currency: [0.18, 0.028], company: [0.28, 0.028], job_title: [0.26, 0.028], attachment: [0.3, 0.05],
};

const EXTRA_KEYS: Partial<Record<FieldType, string[]>> = {
  text: ["maxLength", "pattern"], long_text: ["maxLength"], date: ["min", "max"], number: ["min", "max", "decimals"], currency: ["currency", "min", "max"], company: ["maxLength"], job_title: ["maxLength"], attachment: ["maxBytes", "allowedMime"],
};
export const extraKeys = (t: FieldType) => EXTRA_KEYS[t] ?? [];
export const hasOptions = (t: FieldType) => t === "radio" || t === "dropdown";
export const acceptsDefault = (t: FieldType) => !["signature", "initials", "checkbox", "attachment"].includes(t);

export const newFieldId = () => `f_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export function makeField(type: FieldType, partyId: string, page: number, cx: number, cy: number): EditorField {
  const [w, h] = DEFAULT_SIZE[type];
  const x = Math.min(Math.max(cx - w / 2, 0), 1 - w), y = Math.min(Math.max(cy - h / 2, 0), 1 - h);
  return { id: newFieldId(), partyId, type, label: "", required: type !== "checkbox", page, x, y, w, h, options: type === "radio" ? ["Option 1", "Option 2"] : type === "dropdown" ? ["Option 1"] : [], extras: type === "currency" ? { currency: "GBP" } : {}, defaultValue: "" };
}

/** Editor -> API (kit field + defaultValue). Only keys valid for the type are sent. */
export function toApi(f: EditorField) {
  const extras: Record<string, unknown> = {};
  for (const k of extraKeys(f.type)) if (f.extras[k] !== undefined && f.extras[k] !== "" && f.extras[k] !== null) extras[k] = f.extras[k];
  return { id: f.id, recipientId: f.partyId, type: f.type, label: f.label || undefined, required: f.required, rect: { page: f.page, x: f.x, y: f.y, width: f.w, height: f.h }, ...(hasOptions(f.type) ? { options: f.options.filter((o) => o.trim()) } : {}), ...extras, ...(acceptsDefault(f.type) && f.defaultValue ? { defaultValue: f.defaultValue } : {}) };
}

type Row = { key: string; recipientId: string; type: string; label: string; page: number; x: number; y: number; w: number; h: number; required: boolean; options: string[]; validation: Record<string, unknown> | null; defaultValue: string | null };
export function fromRow(r: Row): EditorField {
  const extras: Record<string, unknown> = {};
  for (const k of extraKeys(r.type as FieldType)) if (r.validation && k in r.validation) extras[k] = r.validation[k];
  return { id: r.key, partyId: r.recipientId, type: r.type as FieldType, label: r.label, required: r.required, page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, options: r.options ?? [], extras, defaultValue: r.defaultValue ?? "" };
}

/** Template fields are stored in the API (kit) shape; rebuild the editor shape from them. */
export function fromKit(k: Record<string, unknown> & { id: string; recipientId: string; type: string; rect: { page: number; x: number; y: number; width: number; height: number } }): EditorField {
  const extras: Record<string, unknown> = {};
  for (const key of extraKeys(k.type as FieldType)) if (key in k) extras[key] = k[key];
  return { id: k.id, partyId: k.recipientId, type: k.type as FieldType, label: String(k.label ?? ""), required: k.required !== false, page: k.rect.page, x: k.rect.x, y: k.rect.y, w: k.rect.width, h: k.rect.height, options: (k.options as string[] | undefined) ?? [], extras, defaultValue: String(k.defaultValue ?? "") };
}
