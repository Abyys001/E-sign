import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { makeOrg, makePdf, ctxFor, pngDataUrl } from "./helpers";
import { addRecipient, createContract, saveFields, sendContract, uploadVersion, readiness } from "@/server/contracts/service";
import { bindSession, loadByToken, markViewed, submitSigning } from "@/server/signing/service";
import { finalizeContract } from "@/server/signing/finalize";
import { verifyAuditChain } from "@/server/audit";
import { deriveSigningToken } from "@/server/crypto";
import { stopBoss } from "@/server/jobs";
import { storage } from "@/server/storage";
import { sha256Bytes } from "@/server/kit/pdf/hash";
import { PDFDocument } from "@cantoo/pdf-lib";

afterAll(stopBoss);

async function setup() {
  const { org, user } = await makeOrg("Flow Org");
  const a = { orgId: org.id, userId: user.id, ctx: ctxFor() };
  const contract = await db.transaction((tx) => createContract(tx, a, { name: "Venue agreement", contractType: "venue" }));
  return { org, user, a, contract };
}

async function tokenFor(contractId: string, recipientId: string) {
  const [r] = await db.select().from(schema.signatureRequests).where(and(eq(schema.signatureRequests.contractId, contractId), eq(schema.signatureRequests.recipientId, recipientId), eq(schema.signatureRequests.status, "ACTIVE")));
  return r ? deriveSigningToken(r.id, r.tokenNonce) : null;
}

const sigField = (id: string, recipientId: string, page = 0, y = 0.7) => ({ id, recipientId, type: "signature", rect: { page, x: 0.1, y, width: 0.3, height: 0.08 }, required: true });

describe("full signing flow (two sequential signers)", () => {
  it("sends, signs in order, finalizes, and keeps a valid audit chain", async () => {
    const { org, a, contract } = await setup();
    const pdf = await makePdf(2);
    await db.transaction((tx) => uploadVersion(tx, a, contract.id, pdf, "initial"));
    const r1 = await db.transaction((tx) => addRecipient(tx, a, contract.id, { name: "Alice Artist", email: "alice@example.test", signingOrder: 1 }));
    const r2 = await db.transaction((tx) => addRecipient(tx, a, contract.id, { name: "Bob Booker", email: "bob@example.test", signingOrder: 2 }));

    expect((await readiness(db, contract.id)).map((i) => i.code)).toContain("no_signature_field");
    await db.transaction((tx) => saveFields(tx, a, contract.id, [
      sigField("sig-alice", r1.id), { id: "name-alice", recipientId: r1.id, type: "text", label: "Full name", rect: { page: 0, x: 0.1, y: 0.5, width: 0.4, height: 0.04 }, required: true },
      sigField("sig-bob", r2.id, 1), { id: "agree-bob", recipientId: r2.id, type: "checkbox", rect: { page: 1, x: 0.1, y: 0.5, width: 0.04, height: 0.03 }, required: true },
    ]));
    expect(await readiness(db, contract.id)).toEqual([]);

    const sent = await db.transaction((tx) => sendContract(tx, a, contract.id, { idempotencyKey: "k1" }));
    expect(sent.status).toBe("SENT");
    // idempotent replay returns the same response and creates no duplicate messages
    const again = await db.transaction((tx) => sendContract(tx, a, contract.id, { idempotencyKey: "k1" }));
    expect(again.id).toBe(sent.id);
    const mails = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.contractId, contract.id));
    expect(mails.filter((m) => m.template === "signature_requested")).toHaveLength(1); // only signer 1 is invited (sequential)

    // Bob has no link yet.
    expect(await tokenFor(contract.id, r2.id)).toBeNull();
    const t1 = (await tokenFor(contract.id, r1.id))!;
    const ctx = ctxFor();
    const l1 = await loadByToken(t1, ctx);
    const s1 = await bindSession(l1, undefined, ctx);
    await markViewed(l1, ctx);

    // missing required field is rejected
    await expect(submitSigning(t1, s1.sessionValue, { consent: true, locale: "en", fields: { "sig-alice": { signature: { method: "TYPED", typedText: "Alice Artist", imageDataUrl: pngDataUrl() } } } }, ctx)).rejects.toMatchObject({ code: "validation_failed" });
    // consent required
    await expect(submitSigning(t1, s1.sessionValue, { consent: false, locale: "en", fields: {} }, ctx)).rejects.toMatchObject({ code: "validation_failed" });
    // wrong browser session is rejected
    await expect(submitSigning(t1, "not-the-session", { consent: true, locale: "en", fields: {} }, ctx)).rejects.toMatchObject({ code: "forbidden" });

    const r = await submitSigning(t1, s1.sessionValue, { consent: true, locale: "en", fields: { "sig-alice": { signature: { method: "DRAWN", imageDataUrl: pngDataUrl() } }, "name-alice": { value: { kind: "text", text: "Alice Artist" } } } }, ctx);
    expect(r.contractComplete).toBe(false);
    expect(r.next).toEqual(["Bob Booker"]);
    // token is single-use
    await expect(submitSigning(t1, s1.sessionValue, { consent: true, locale: "en", fields: {} }, ctx)).rejects.toMatchObject({ status: 409 });

    const t2 = (await tokenFor(contract.id, r2.id))!;
    expect(t2).toBeTruthy();
    const l2 = await loadByToken(t2, ctx);
    const s2 = await bindSession(l2, undefined, ctx);
    const done = await submitSigning(t2, s2.sessionValue, { consent: true, locale: "en", fields: { "sig-bob": { signature: { method: "TYPED", typedText: "Bob Booker", imageDataUrl: pngDataUrl() } }, "agree-bob": { value: { kind: "bool", checked: true } } } }, ctx);
    expect(done.contractComplete).toBe(true);

    // Two finalizers race: exactly one produces artifacts.
    const [f1, f2] = await Promise.all([finalizeContract(contract.id), finalizeContract(contract.id)]);
    expect([f1.status, f2.status].sort()).toEqual(["already", "completed"]);
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, contract.id));
    expect(c!.status).toBe("COMPLETED");
    const finals = await db.select().from(schema.contractVersions).where(and(eq(schema.contractVersions.contractId, contract.id), eq(schema.contractVersions.kind, "FINAL")));
    expect(finals).toHaveLength(1);
    const [obj] = await db.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, finals[0]!.storageObjectId));
    const bytes = await storage().getBuffer(obj!.key);
    expect(sha256Bytes(bytes)).toBe(finals[0]!.sha256);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    const certs = await db.select().from(schema.completionCertificates).where(eq(schema.completionCertificates.contractId, contract.id));
    expect(certs).toHaveLength(1);
    expect(certs[0]!.finalDocumentHash).toBe(finals[0]!.sha256);

    if (process.env.KEEP_ARTIFACTS) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.KEEP_ARTIFACTS}/final.pdf`, bytes);
      const [cobj] = await db.select().from(schema.storageObjects).where(eq(schema.storageObjects.id, certs[0]!.storageObjectId));
      writeFileSync(`${process.env.KEEP_ARTIFACTS}/certificate.pdf`, await storage().getBuffer(cobj!.key));
    }
    const chain = await verifyAuditChain(contract.id);
    expect(chain.ok).toBe(true);
    expect(chain.count).toBeGreaterThan(15);
    const types = (await db.select({ t: schema.auditEvents.eventType }).from(schema.auditEvents).where(eq(schema.auditEvents.contractId, contract.id))).map((e) => e.t);
    for (const t of ["contract.created", "contract.sent", "document.viewed", "consent.given", "signature.applied", "signing.locked", "document.final_generated", "certificate.generated", "contract.completed"]) expect(types).toContain(t);
    void org;
  });
});
