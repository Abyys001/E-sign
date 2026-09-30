import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import { normalizeRotation, toPdfRect, type PageGeometry, type RelativeRect } from './field-coordinates';
import { DEFAULT_LIMITS, assertBytesWithinLimit, assertPagesWithinLimit, type PdfLimits } from './limits';

export type StampItem =
  | { kind: 'text'; rect: RelativeRect; text: string; fontSize?: number }
  | { kind: 'date'; rect: RelativeRect; date: Date; fontSize?: number }
  | { kind: 'checkbox'; rect: RelativeRect; checked: boolean }
  | { kind: 'image'; rect: RelativeRect; format: 'png' | 'jpg'; bytes: Uint8Array };

type Pt = { x: number; y: number };

function geometryOf(page: PDFPage): PageGeometry {
  const b = page.getCropBox();
  return { box: [b.x, b.y, b.x + b.width, b.y + b.height], rotate: normalizeRotation(page.getRotation().angle) };
}

/**
 * Point in the DISPLAYED page (fractions, top-left origin) -> unrotated user space (points).
 * Same mapping as toPdfRect, exposed per point so drawing primitives can anchor anywhere.
 */
export function displayedToUser(g: PageGeometry, dx: number, dy: number): Pt {
  const [llx, lly, urx, ury] = g.box;
  const w = urx - llx;
  const h = ury - lly;
  let ux: number, uy: number;
  switch (g.rotate) {
    case 0: ux = dx; uy = 1 - dy; break;
    case 90: ux = dy; uy = dx; break;
    case 180: ux = 1 - dx; uy = dy; break;
    case 270: ux = 1 - dy; uy = 1 - dx; break;
  }
  return { x: llx + ux * w, y: lly + uy * h };
}

/** Displayed page size in points (width/height swap for 90/270). */
export function displayedSize(g: PageGeometry): { width: number; height: number } {
  const w = g.box[2] - g.box[0];
  const h = g.box[3] - g.box[1];
  return g.rotate === 90 || g.rotate === 270 ? { width: h, height: w } : { width: w, height: h };
}

function fitFontSize(font: PDFFont, text: string, maxWidth: number, maxHeight: number, preferred?: number): number {
  let size = Math.min(preferred ?? maxHeight * 0.7, maxHeight * 0.9);
  const width = font.widthOfTextAtSize(text, size);
  if (width > maxWidth) size = size * (maxWidth / width);
  return size;
}

function requirePage(doc: PDFDocument, index: number): PDFPage {
  const page = doc.getPages()[index];
  if (!page) throw new RangeError(`page ${index} does not exist`);
  return page;
}

/**
 * Draw items onto pages. Content is drawn rotated by the page's /Rotate (counter-clockwise) so it reads upright when displayed,
 * and anchored from the bottom-left of the displayed field rect. Text uses a standard Helvetica font (WinAnsi only):
 * unencodable characters throw. For non-Latin text, render the value as an image or embed a font via fontkit in your app.
 */
export async function stampItems(doc: PDFDocument, items: StampItem[]): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const item of items) {
    const page = requirePage(doc, item.rect.page);
    const g = geometryOf(page);
    const { width: pw, height: ph } = displayedSize(g);
    const boxW = item.rect.width * pw;
    const boxH = item.rect.height * ph;
    const angle = degrees(g.rotate);
    // toPdfRect validates bounds; we only use it for the check and for the bounding box of the field in user space.
    toPdfRect(item.rect, g);

    if (item.kind === 'text' || item.kind === 'date') {
      const text = item.kind === 'text' ? item.text : item.date.toISOString().slice(0, 10);
      if (!text) continue;
      const size = fitFontSize(font, text, boxW, boxH, item.fontSize);
      const baselineOffset = (boxH - size) / 2 + size * 0.2;
      // Anchor at the displayed bottom-left of the field, lifted by baselineOffset along the displayed "up" axis.
      const up = displayedToUser(g, item.rect.x, item.rect.y + item.rect.height - baselineOffset / ph);
      page.drawText(text, { x: up.x, y: up.y, size, font, color: rgb(0, 0, 0), rotate: angle });
    } else if (item.kind === 'image') {
      const img = item.format === 'png' ? await doc.embedPng(item.bytes) : await doc.embedJpg(item.bytes);
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const offX = (boxW - w) / 2 / pw;
      const offY = (boxH - h) / 2 / ph;
      const bl = displayedToUser(g, item.rect.x + offX, item.rect.y + item.rect.height - offY);
      page.drawImage(img, { x: bl.x, y: bl.y, width: w, height: h, rotate: angle });
    } else {
      const side = Math.min(boxW, boxH);
      const inset = (v: number) => v / pw;
      const x0 = item.rect.x;
      const y0 = item.rect.y + item.rect.height;
      const corner = (fx: number, fy: number) => displayedToUser(g, x0 + inset(fx), y0 - fy / ph);
      const c = [corner(0, 0), corner(side, 0), corner(side, side), corner(0, side)] as const;
      for (let i = 0; i < 4; i++) {
        const a = c[i]!;
        const b = c[(i + 1) % 4]!;
        page.drawLine({ start: a, end: b, thickness: 1, color: rgb(0, 0, 0) });
      }
      if (item.checked) {
        const p1 = corner(side * 0.2, side * 0.55);
        const p2 = corner(side * 0.42, side * 0.8);
        const p3 = corner(side * 0.82, side * 0.2);
        page.drawLine({ start: p1, end: p2, thickness: 1.5, color: rgb(0, 0, 0) });
        page.drawLine({ start: p2, end: p3, thickness: 1.5, color: rgb(0, 0, 0) });
      }
    }
  }
}

/** Turn AcroForm fields into static page content. Do this before sealing: any later change breaks a cryptographic signature. */
export function flattenForm(doc: PDFDocument): void {
  doc.getForm().flatten();
}

/** Append every page of `extra` (e.g. the completion certificate) to `base`. */
export async function appendPdf(base: PDFDocument, extra: Uint8Array, limits: PdfLimits = DEFAULT_LIMITS): Promise<void> {
  assertBytesWithinLimit(extra.byteLength, limits);
  const src = await PDFDocument.load(extra, { updateMetadata: false });
  assertPagesWithinLimit(base.getPageCount() + src.getPageCount(), limits);
  const pages = await base.copyPages(src, src.getPageIndices());
  for (const p of pages) base.addPage(p);
}

export async function loadPdf(bytes: Uint8Array, limits: PdfLimits = DEFAULT_LIMITS): Promise<PDFDocument> {
  assertBytesWithinLimit(bytes.byteLength, limits);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  assertPagesWithinLimit(doc.getPageCount(), limits);
  return doc;
}

/** Deterministic save: no object streams, so identical inputs give byte-identical output (needed for stable hashes in tests). */
export const savePdf = (doc: PDFDocument): Promise<Uint8Array> => doc.save({ useObjectStreams: false, updateFieldAppearances: false });
