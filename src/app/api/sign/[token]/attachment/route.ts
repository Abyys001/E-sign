import { AppError } from "@/server/errors";
import { open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { db, schema } from "@/db";
import { assertClean } from "@/server/scan";
import { storage } from "@/server/storage";
import { objectKey } from "@/server/storage/keys";
import { assertActive, assertSession, loadByToken, needsVerification, signCookieName } from "@/server/signing/service";

const MAX = 5 * 1024 * 1024;
const kind = (b: Buffer) => (b.subarray(0, 4).toString() === "%PDF" ? "application/pdf" : b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG" ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : null);

/** Signer attachment (ID card, receipt…). Type is decided from the bytes, never from the filename or declared type. */
export const POST = open<{ token: string }>(async ({ req, ctx, params }) => {
  await rateLimit("signingSubmit", `att:${ctx.ip}`);
  const l = await loadByToken(params.token, ctx);
  assertActive(l);
  assertSession(l, req.cookies.get(signCookieName(l.request.id))?.value);
  if (needsVerification(l) !== "NONE") throw new AppError("forbidden", "Verify your identity first.");
  const f = (await req.formData()).get("file");
  if (!(f instanceof File)) throw new AppError("validation_failed", "Choose a file.");
  if (f.size > MAX) throw new AppError("payload_too_large", "The file is larger than 5 MB.");
  const buf = Buffer.from(await f.arrayBuffer());
  const mime = kind(buf);
  if (!mime) throw new AppError("unsupported_media", "Attach a PDF, PNG or JPEG file.");
  await assertClean(buf);
  const key = objectKey(l.contract.organisationId, "signature");
  const put = await storage().put(key, buf, mime);
  const [o] = await db.insert(schema.storageObjects).values({ organisationId: l.contract.organisationId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: mime }).returning();
  return { objectId: o!.id, bytes: put.sizeBytes, mime };
});
