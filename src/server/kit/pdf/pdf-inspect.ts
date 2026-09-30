import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { normalizeRotation, type PageGeometry } from './field-coordinates';
import { DEFAULT_LIMITS, assertBytesWithinLimit, assertPagesWithinLimit, type PdfLimits } from './limits';

export interface PdfInspection {
  pageCount: number;
  pages: PageGeometry[];
  isEncrypted: boolean;
  /** Names of active-content features found (e.g. "JavaScript", "OpenAction"). Empty = none detected by this scan. */
  activeContent: string[];
  hasAcroForm: boolean;
}

export class PdfRejectedError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`PDF rejected: ${reasons.join(', ')}`);
    this.name = 'PdfRejectedError';
    this.reasons = reasons;
  }
}

const ACTIVE_KEYS = ['JS', 'JavaScript', 'OpenAction', 'AA', 'EmbeddedFiles', 'RichMedia', 'XFA'];
const ACTIVE_ACTIONS = new Set(['Launch', 'JavaScript', 'ImportData', 'SubmitForm', 'URI', 'GoToR']);

function scanActiveContent(doc: PDFDocument): string[] {
  const found = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : 'dict' in (obj as object) ? ((obj as { dict?: PDFDict }).dict) : undefined;
    if (!(dict instanceof PDFDict)) continue;
    for (const key of ACTIVE_KEYS) if (dict.has(PDFName.of(key))) found.add(key);
    const action = dict.get(PDFName.of('S'));
    if (action instanceof PDFName && ACTIVE_ACTIONS.has(action.decodeText())) found.add(action.decodeText());
  }
  return [...found].sort();
}

/**
 * Loads with @cantoo/pdf-lib, which parses the whole file into memory: enforce byte/page limits first and run this in a
 * worker with a timeout (see backend/pdf-worker). This is a structural scan, not malware detection: still run ClamAV/qpdf --check upstream.
 */
export async function inspectPdf(bytes: Uint8Array, limits: PdfLimits = DEFAULT_LIMITS): Promise<PdfInspection> {
  assertBytesWithinLimit(bytes.byteLength, limits);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  const pageCount = doc.getPageCount();
  assertPagesWithinLimit(pageCount, limits);
  const pages = doc.getPages().map((p): PageGeometry => {
    const b = p.getCropBox();
    return { box: [b.x, b.y, b.x + b.width, b.y + b.height], rotate: normalizeRotation(p.getRotation().angle) };
  });
  return {
    pageCount,
    pages,
    isEncrypted: doc.isEncrypted,
    activeContent: scanActiveContent(doc),
    hasAcroForm: doc.catalog.has(PDFName.of('AcroForm')),
  };
}

/** Convenience gate for upload pipelines: reject encrypted files and any active content. */
export async function assertSafeToProcess(bytes: Uint8Array, limits: PdfLimits = DEFAULT_LIMITS): Promise<PdfInspection> {
  const info = await inspectPdf(bytes, limits);
  const reasons = [...(info.isEncrypted ? ['encrypted'] : []), ...info.activeContent.map((a) => `active:${a}`)];
  if (reasons.length) throw new PdfRejectedError(reasons);
  return info;
}
