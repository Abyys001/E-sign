import { open } from "@/server/http";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { inProgressPdf } from "@/server/signing/finalize";
import { loadVersionBytes } from "@/server/documents";
import { assertActive, assertSession, loadByToken, needsVerification, signCookieName } from "@/server/signing/service";

/** The document the signer is asked to sign: only with an active link, the bound browser session and completed verification. */
export const GET = open<{ token: string }>(async ({ req, ctx, params }) => {
  await rateLimit("download", `sign:${ctx.ip}`);
  const l = await loadByToken(params.token, ctx);
  assertActive(l);
  assertSession(l, req.cookies.get(signCookieName(l.request.id))?.value);
  if (needsVerification(l) !== "NONE") throw new AppError("forbidden", "Verify your identity first.", { code: "verification_required" });
  if (!l.contract.signingVersionId) throw new AppError("not_found", "Document not found");
  const source = await loadVersionBytes(l.contract.organisationId, l.contract.signingVersionId);
  // Show what earlier signers have completed (e.g. Bilit's signature) on the document this signer reviews.
  const others = await db.select().from(schema.recipientFields).where(and(eq(schema.recipientFields.contractId, l.contract.id), ne(schema.recipientFields.recipientId, l.recipient.id)));
  const bytes = await inProgressPdf(l.contract.organisationId, source, others);
  if (req.nextUrl.searchParams.get("download") === "1") await db.transaction((tx) => audit(tx, { organisationId: l.contract.organisationId, contractId: l.contract.id, recipientId: l.recipient.id, eventType: "document.downloaded", ctx, metadata: { artifact: "source", by: "signer" } }));
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-length": String(bytes.length), "content-disposition": `inline; filename="document.pdf"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
