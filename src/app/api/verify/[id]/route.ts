import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/server/errors";
import { body, open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { safeEqual } from "@/server/crypto";
import { verifyAuditChain } from "@/server/audit";

async function find(id: string) {
  const [c] = /^[A-Za-z0-9_-]{8,64}$/.test(id) ? await db.select().from(schema.contracts).where(eq(schema.contracts.verificationId, id)) : [];
  if (!c || !c.finalVersionId) throw new AppError("not_found", "No completed document matches this verification code.");
  const [[v], [cert], [org], recips] = await Promise.all([
    db.select().from(schema.contractVersions).where(eq(schema.contractVersions.id, c.finalVersionId)),
    db.select().from(schema.completionCertificates).where(eq(schema.completionCertificates.contractId, c.id)),
    db.select({ name: schema.organisations.name }).from(schema.organisations).where(eq(schema.organisations.id, c.organisationId)),
    db.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, c.id), isNull(schema.recipients.deletedAt))),
  ]);
  return { c, v: v!, cert, org, recips };
}

/** Public verification: minimum disclosure (names, times, hashes). No email, IP or document content. */
export const GET = open<{ id: string }>(async ({ ctx, params }) => {
  await rateLimit("signingOpen", `verify:${ctx.ip}`);
  const { c, v, cert, org, recips } = await find(params.id);
  const chain = await verifyAuditChain(c.id);
  return {
    verified: true, organisation: org?.name ?? "", contractName: c.name, reference: c.reference, completedAt: c.completedAt,
    certificateId: cert?.certificateId ?? null, finalDocumentHash: v.sha256, auditChainIntact: chain.ok,
    signers: recips.filter((r) => r.role !== "CC" && r.status === "COMPLETED").map((r) => ({ name: r.name, signedAt: r.completedAt })),
  };
});

/** Compare a SHA-256 computed in the visitor's browser with the recorded final hash. The file itself is never uploaded. */
export const POST = open<{ id: string }>(async ({ req, ctx, params }) => {
  await rateLimit("signingOpen", `verify:${ctx.ip}`);
  const { hash } = await body(req, z.object({ hash: z.string().regex(/^[0-9a-fA-F]{64}$/) }));
  const { v } = await find(params.id);
  return { match: safeEqual(hash.toLowerCase(), v.sha256.toLowerCase()) };
});
