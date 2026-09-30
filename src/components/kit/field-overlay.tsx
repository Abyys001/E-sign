import type { CSSProperties, ReactNode } from 'react';

/** Same shape as backend/pdf/src/field-coordinates.ts RelativeRect: fractions of the visible page, top-left origin. */
export interface RelativeRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldOverlayItem {
  id: string;
  rect: RelativeRect;
  /** Tailwind/CSS color token for the assigned recipient. Color must never be the only cue: pair with `label`. */
  color: string;
  label: string;
  required?: boolean;
  filled?: boolean;
  children?: ReactNode;
}

interface Props {
  page: number;
  fields: FieldOverlayItem[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
}

const style = (r: RelativeRect): CSSProperties => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.width * 100}%`,
  height: `${r.height * 100}%`,
});

/**
 * Absolutely positioned layer that sits on top of a rendered PDF page (a `relative` wrapper the size of the page canvas).
 * Percent geometry means it stays aligned at every zoom level with no recalculation.
 */
export function FieldOverlay({ page, fields, activeId, onSelect }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {fields
        .filter((f) => f.rect.page === page)
        .map((f) => (
          <button
            key={f.id}
            type="button"
            style={{ ...style(f.rect), borderColor: f.color }}
            aria-label={`${f.label}${f.required ? ' (required)' : ''}`}
            aria-current={activeId === f.id}
            onClick={() => onSelect?.(f.id)}
            className="pointer-events-auto absolute flex items-center justify-center overflow-hidden border-2 bg-white/60 text-xs aria-[current=true]:ring-2 aria-[current=true]:ring-offset-1"
          >
            {f.children ?? <span className="truncate px-1">{f.label}</span>}
            {f.required && !f.filled && <span aria-hidden className="absolute end-0.5 top-0 text-red-600">*</span>}
          </button>
        ))}
    </div>
  );
}

/** Next required, unfilled field in document order (page, then top-to-bottom, then start→end). Drives the "Next" button. */
export function nextRequiredField(fields: FieldOverlayItem[], afterId?: string | null): FieldOverlayItem | undefined {
  const pending = fields
    .filter((f) => f.required && !f.filled)
    .sort((a, b) => a.rect.page - b.rect.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (!afterId) return pending[0];
  const idx = pending.findIndex((f) => f.id === afterId);
  return pending[idx + 1] ?? pending[0];
}
