import type { Readable } from "node:stream";

export interface PutResult { key: string; sizeBytes: number; sha256: string }

export interface StorageProvider {
  readonly name: "local" | "s3";
  put(key: string, body: Buffer | Readable, contentType: string): Promise<PutResult>;
  getStream(key: string): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Temporary URL. Local provider returns null; callers stream through an authorised route instead. */
  signedUrl(key: string, ttlSeconds: number, downloadName?: string): Promise<string | null>;
}
