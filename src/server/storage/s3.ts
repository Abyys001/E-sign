import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { isSafeKey } from "./keys";
import type { PutResult, StorageProvider } from "./provider";

export type S3Config = { bucket: string; region: string; endpoint?: string; accessKey?: string; secretKey?: string };

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Works with AWS S3, Cloudflare R2, MinIO and other S3-compatible stores. Objects are private; access is via presigned URLs only. */
export class S3Storage implements StorageProvider {
  readonly name = "s3" as const;
  private client: S3Client;
  constructor(private cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: !!cfg.endpoint,
      credentials: cfg.accessKey && cfg.secretKey ? { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey } : undefined,
    });
  }
  async put(key: string, body: Buffer | Readable, contentType: string): Promise<PutResult> {
    if (!isSafeKey(key)) throw new Error("invalid storage key");
    const buf = await toBuffer(body); // PutObject needs a known length; PDFs are capped by MAX_UPLOAD_MB
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: buf, ContentType: contentType, ServerSideEncryption: this.cfg.endpoint ? undefined : "AES256" }));
    return { key, sizeBytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  async getStream(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return r.Body as Readable;
  }
  async getBuffer(key: string) { return toBuffer(await this.getStream(key)); }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key })); }
  async signedUrl(key: string, ttl: number, downloadName?: string) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.cfg.bucket, Key: key,
      ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replace(/"/g, "")}"` : undefined,
    }), { expiresIn: ttl });
  }
}
