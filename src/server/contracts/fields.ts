import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { schema } from "@/db";
import { FieldSchema, parseField, type Field } from "../kit/fields/fields";
import { assertRelative } from "../kit/pdf/field-coordinates";

type Row = InferSelectModel<typeof schema.recipientFields>;

export const FIELD_TYPES = ["signature", "initials", "text", "long_text", "email", "phone", "date", "datetime", "checkbox", "radio", "dropdown", "number", "currency", "company", "job_title", "attachment"] as const;
export type FieldTypeName = (typeof FIELD_TYPES)[number];

/** Field types the signer fills by capturing an image (routed to signature evidence, never trusted as plain text). */
export const SIGNATURE_TYPES = new Set<string>(["signature", "initials"]);
/** Text-like types that are stamped as text and can therefore carry a browser-rendered image for non-Latin scripts. */
export const TEXTUAL_TYPES = new Set<string>(["text", "long_text", "email", "phone", "date", "datetime", "radio", "dropdown", "number", "currency", "company", "job_title"]);

const BASE_KEYS = new Set(["id", "recipientId", "rect", "required", "version", "visibleWhen", "label", "calculated", "type"]);

/** API payload for one field: the kit's discriminated schema plus a default value. */
export const FieldPayload = z.looseObject({ defaultValue: z.string().max(500).nullish() });
export type PreparedField = { key: string; recipientId: string; type: string; label: string; page: number; x: number; y: number; w: number; h: number; required: boolean; defaultValue: string | null; options: string[]; validation: Record<string, unknown> };

/** Validate + normalise one client field into DB columns. Coordinates are page fractions, checked against the page count. */
export function prepareField(raw: unknown, pageCount: number): PreparedField {
  const { defaultValue, ...rest } = FieldPayload.parse(raw);
  const f = parseField(rest);
  if (f.rect.page >= pageCount) throw new RangeError(`Field "${f.id}" is on page ${f.rect.page + 1}, but the document has ${pageCount} pages.`);
  assertRelative({ page: f.rect.page, x: f.rect.x, y: f.rect.y, width: f.rect.width, height: f.rect.height });
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (!BASE_KEYS.has(k) && k !== "options") extras[k] = v;
  extras.visibleWhen = f.visibleWhen;
  if (f.calculated) extras.calculated = f.calculated;
  const options = "options" in f ? [...f.options] : [];
  return { key: f.id, recipientId: f.recipientId, type: f.type, label: f.label ?? "", page: f.rect.page, x: f.rect.x, y: f.rect.y, w: f.rect.width, h: f.rect.height, required: f.required, defaultValue: defaultValue ?? null, options, validation: extras };
}

/** DB row -> kit field. The client-facing id is `key`; the DB uuid never leaves the server for signers. */
export function toKitField(r: Row): Field {
  const ex = (r.validation ?? {}) as Record<string, unknown>;
  const candidate = {
    ...ex, id: r.key, recipientId: r.recipientId, type: r.type, label: r.label || undefined, required: r.required,
    rect: { page: r.page, x: r.x, y: r.y, width: r.w, height: r.h }, ...(r.options.length ? { options: r.options } : {}),
  };
  return FieldSchema.parse(candidate);
}

export type FieldDto = { id: string; key: string; recipientId: string; type: string; label: string; page: number; x: number; y: number; width: number; height: number; required: boolean; defaultValue: string | null; options: string[]; validation: Record<string, unknown>; filled: boolean };
export const fieldDto = (r: Row): FieldDto => ({ id: r.id, key: r.key, recipientId: r.recipientId, type: r.type, label: r.label, page: r.page, x: r.x, y: r.y, width: r.w, height: r.h, required: r.required, defaultValue: r.defaultValue, options: r.options, validation: (r.validation ?? {}) as Record<string, unknown>, filled: !!r.filledAt });

/** True when every char is encodable in the standard Helvetica (WinAnsi) font used for stamping. */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0xff) continue; // Latin-1 is a subset of WinAnsi for printable characters
    if ("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".includes(ch)) continue;
    return false;
  }
  return true;
}
