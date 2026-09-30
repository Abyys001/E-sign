import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isSafeKey } from "./keys";
import type { PutResult, StorageProvider } from "./provider";

export class LocalStorage implements StorageProvider {
  readonly name = "local" as const;
  private root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  private resolve(key: string): string {
    if (!isSafeKey(key)) throw new Error("invalid storage key");
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("path traversal blocked");
    return p;
  }

  async put(key: string, body: Buffer | Readable): Promise<PutResult> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
    try {
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, meter, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
      await rename(tmp, dest);
    } catch (e) { await rm(tmp, { force: true }); throw e; }
    return { key, sizeBytes: size, sha256: hash.digest("hex") };
  }
  async getStream(key: string) { return createReadStream(this.resolve(key)); }
  async getBuffer(key: string) { return readFile(this.resolve(key)); }
  async delete(key: string) { await rm(this.resolve(key), { force: true }); }
  async signedUrl() { return null; }
}
