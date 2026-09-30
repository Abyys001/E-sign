import { env } from "@/lib/env";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { StorageProvider } from "./provider";

let instance: StorageProvider | undefined;

export function storage(): StorageProvider {
  if (instance) return instance;
  const e = env();
  if (e.CONTRACT_STORAGE_PROVIDER === "s3") {
    if (!e.CONTRACT_STORAGE_BUCKET || !e.CONTRACT_STORAGE_REGION) throw new Error("S3 storage requires CONTRACT_STORAGE_BUCKET and CONTRACT_STORAGE_REGION");
    return (instance = new S3Storage({ bucket: e.CONTRACT_STORAGE_BUCKET, region: e.CONTRACT_STORAGE_REGION, endpoint: e.CONTRACT_STORAGE_ENDPOINT, accessKey: e.CONTRACT_STORAGE_ACCESS_KEY, secretKey: e.CONTRACT_STORAGE_SECRET_KEY }));
  }
  return (instance = new LocalStorage(e.CONTRACT_STORAGE_LOCAL_DIR));
}
export type { StorageProvider } from "./provider";
