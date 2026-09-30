/**
 * Field geometry. Stored form: fractions (0..1) of the VISIBLE page (CropBox) in its displayed (post-/Rotate)
 * orientation, origin top-left. That form is identical in the browser at any zoom and on mobile, and survives
 * re-rendering. Convert to PDF points only server-side at stamping time.
 */
export interface RelativeRect { page: number; x: number; y: number; width: number; height: number }
export interface PageGeometry {
  /** CropBox (or MediaBox if none): [llx, lly, urx, ury] in points, unrotated. */
  box: [number, number, number, number];
  /** /Rotate: 0, 90, 180, 270 (already normalised). */
  rotate: 0 | 90 | 180 | 270;
}
export interface PdfRect { x: number; y: number; width: number; height: number } // bottom-left origin, points, unrotated user space

export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

export function assertRelative(r: RelativeRect): void {
  const ok = [r.x, r.y, r.width, r.height].every(Number.isFinite)
    && r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9;
  if (!ok) throw new RangeError('field rect outside page bounds');
}

export function toPdfRect(r: RelativeRect, g: PageGeometry): PdfRect {
  assertRelative(r);
  const [llx, lly, urx, ury] = g.box;
  const w = urx - llx;
  const h = ury - lly;
  // Displayed page is w×h for 0/180 and h×w for 90/270. Map displayed (top-left, fractions) → unrotated user space.
  let ux: number, uy: number, uw: number, uh: number; // fractions in unrotated bottom-left space
  switch (g.rotate) {
    case 0:   ux = r.x;               uy = 1 - r.y - r.height; uw = r.width;  uh = r.height; break;
    case 90:  ux = r.y;               uy = r.x;                uw = r.height; uh = r.width;  break;
    case 180: ux = 1 - r.x - r.width; uy = r.y;                uw = r.width;  uh = r.height; break;
    case 270: ux = 1 - r.y - r.height; uy = 1 - r.x - r.width; uw = r.height; uh = r.width;  break;
  }
  return { x: llx + ux * w, y: lly + uy * h, width: uw * w, height: uh * h };
}

/** Inverse of toPdfRect, used to hydrate the editor from stamped/imported PDFs. */
export function toRelativeRect(p: PdfRect, page: number, g: PageGeometry): RelativeRect {
  const [llx, lly, urx, ury] = g.box;
  const w = urx - llx;
  const h = ury - lly;
  const ux = (p.x - llx) / w, uy = (p.y - lly) / h, uw = p.width / w, uh = p.height / h;
  switch (g.rotate) {
    case 0:   return { page, x: ux, y: 1 - uy - uh, width: uw, height: uh };
    case 90:  return { page, x: uy, y: ux, width: uh, height: uw };
    case 180: return { page, x: 1 - ux - uw, y: uy, width: uw, height: uh };
    case 270: return { page, x: 1 - uy - uh, y: 1 - ux - uw, width: uh, height: uw };
  }
}
