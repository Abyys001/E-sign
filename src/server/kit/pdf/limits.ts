export interface PdfLimits {
  maxBytes: number;
  maxPages: number;
}

export const DEFAULT_LIMITS: PdfLimits = { maxBytes: 25 * 1024 * 1024, maxPages: 500 };

export class PdfLimitError extends Error {
  readonly kind: 'bytes' | 'pages';
  constructor(kind: 'bytes' | 'pages', message: string) {
    super(message);
    this.name = 'PdfLimitError';
    this.kind = kind;
  }
}

export function assertBytesWithinLimit(byteLength: number, limits: PdfLimits = DEFAULT_LIMITS): void {
  if (byteLength > limits.maxBytes) throw new PdfLimitError('bytes', `PDF is ${byteLength} bytes; limit is ${limits.maxBytes}`);
}

export function assertPagesWithinLimit(pageCount: number, limits: PdfLimits = DEFAULT_LIMITS): void {
  if (pageCount > limits.maxPages) throw new PdfLimitError('pages', `PDF has ${pageCount} pages; limit is ${limits.maxPages}`);
}
