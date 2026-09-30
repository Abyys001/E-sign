import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

export const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Streams the object body (S3 GetObject, fs.createReadStream) so large PDFs are never held twice in memory just to be hashed. */
export async function sha256Stream(stream: Readable | AsyncIterable<Uint8Array>): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}
