import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit, verifyAuditChain } from "@/server/audit";
import { can } from "@/server/rbac";
import { assertTransition, canTransition, InvalidTransitionError, STATUSES } from "@/server/contracts/state-machine";
import { decrypt, encrypt, hashToken, newOtp, newToken } from "@/server/crypto";
import { LocalStorage } from "@/server/storage/local";
import { objectKey } from "@/server/storage/keys";
import { makeOrg, expectPg } from "./helpers";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("state machine", () => {
  it("allows the happy path and blocks invalid jumps", () => {
    expect(canTransition("DRAFT", "READY_TO_SEND")).toBe(true);
    expect(canTransition("READY_TO_SEND", "SENT")).toBe(true);
    expect(canTransition("SENT", "COMPLETED")).toBe(true);
    expect(() => assertTransition("DRAFT", "COMPLETED")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("COMPLETED", "SENT")).toThrow(InvalidTransitionError);
  });
  it("terminal states only go to ARCHIVED; ARCHIVED goes nowhere", () => {
    for (const s of ["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED", "VOIDED"] as const)
      for (const t of STATUSES) expect(canTransition(s, t)).toBe(t === "ARCHIVED");
    for (const t of STATUSES) expect(canTransition("ARCHIVED", t)).toBe(false);
  });
});

describe("rbac", () => {
  it("role grants, extra grants and deny-wins overrides", () => {
    expect(can({ roleKey: "VIEWER", grants: [], denies: [] }, "contracts.view")).toBe(true);
    expect(can({ roleKey: "VIEWER", grants: [], denies: [] }, "contracts.send")).toBe(false);
    expect(can({ roleKey: "VIEWER", grants: ["contracts.send"], denies: [] }, "contracts.send")).toBe(true);
    expect(can({ roleKey: "ADMIN", grants: [], denies: ["contracts.send"] }, "contracts.send")).toBe(false);
    expect(can({ roleKey: "SIGNER", grants: [], denies: [] }, "contracts.view")).toBe(false);
    expect(can(null, "contracts.view")).toBe(false);
  });
});

describe("crypto", () => {
  it("tokens are high entropy, unique, hashed", () => {
    const a = newToken(), b = newToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });
  it("otp is 6 digits and hash is session-bound", () => {
    const o = newOtp();
    expect(o.code).toMatch(/^\d{6}$/);
    expect(o.hash("s1")).not.toBe(o.hash("s2"));
  });
  it("encrypt/decrypt roundtrip and tamper detection", () => {
    const c = encrypt("smtp-pass");
    expect(decrypt(c)).toBe("smtp-pass");
    const [iv, tag, enc] = c.split(".");
    expect(() => decrypt(`${iv}.${tag}.${Buffer.from("x").toString("base64")}${enc}`)).toThrow();
  });
});

describe("storage", () => {
  const root = mkdtempSync(path.join(tmpdir(), "esign-"));
  const s = new LocalStorage(root);
  it("stores under generated keys and hashes content", async () => {
    const key = objectKey("11111111-1111-1111-1111-111111111111", "source");
    const r = await s.put(key, Buffer.from("hello"));
    expect(r.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(r.sizeBytes).toBe(5);
    expect((await s.getBuffer(key)).toString()).toBe("hello");
  });
  it("rejects traversal and non-generated keys", async () => {
    await expect(s.getBuffer("../../etc/passwd")).rejects.toThrow();
    await expect(s.put("orgs/x/source/../../../evil", Buffer.from("x"))).rejects.toThrow();
    expect(existsSync(path.join(root, "..", "evil"))).toBe(false);
  });
});

describe("audit log", () => {
  it("chains events per contract and verifies", async () => {
    const { org, user } = await makeOrg();
    const [c] = await db.insert(schema.contracts).values({ organisationId: org.id, reference: "CTR-T-1", name: "A", createdBy: user.id }).returning();
    await db.transaction(async (tx) => {
      await audit(tx, { organisationId: org.id, contractId: c!.id, userId: user.id, eventType: "contract.created" });
      await audit(tx, { organisationId: org.id, contractId: c!.id, userId: user.id, eventType: "contract.edited", metadata: { a: 1 } });
    });
    expect(await verifyAuditChain(c!.id)).toEqual({ ok: true, count: 2 });
  });
  it("cannot be updated or deleted, even by raw SQL", async () => {
    const { org, user } = await makeOrg();
    const [c] = await db.insert(schema.contracts).values({ organisationId: org.id, reference: "CTR-T-2", name: "B", createdBy: user.id }).returning();
    await db.transaction((tx) => audit(tx, { organisationId: org.id, contractId: c!.id, eventType: "contract.created" }));
    await expectPg(db.execute(sql`update audit_events set event_type='x' where contract_id=${c!.id}`), /append-only/);
    await expectPg(db.execute(sql`delete from audit_events where contract_id=${c!.id}`), /append-only/);
    await expectPg(db.execute(sql`truncate audit_events`), /append-only/);
  });
  it("concurrent appends keep a valid chain", async () => {
    const { org, user } = await makeOrg();
    const [c] = await db.insert(schema.contracts).values({ organisationId: org.id, reference: "CTR-T-3", name: "C", createdBy: user.id }).returning();
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.transaction((tx) => audit(tx, { organisationId: org.id, contractId: c!.id, eventType: `e${i}` }))));
    expect(await verifyAuditChain(c!.id)).toEqual({ ok: true, count: 12 });
  });
});

describe("evidence immutability", () => {
  it("signatures are append-only; locked versions cannot change", async () => {
    const { org, user } = await makeOrg();
    const [c] = await db.insert(schema.contracts).values({ organisationId: org.id, reference: "CTR-T-4", name: "D", createdBy: user.id }).returning();
    const [o] = await db.insert(schema.storageObjects).values({ organisationId: org.id, key: objectKey(org.id, "source"), provider: "local", sizeBytes: 1, sha256: "a", contentType: "application/pdf" }).returning();
    const [v] = await db.insert(schema.contractVersions).values({ contractId: c!.id, organisationId: org.id, version: 1, storageObjectId: o!.id, sha256: "a", pageCount: 1, pageDims: [{ w: 595, h: 842 }], locked: true }).returning();
    await expectPg(db.execute(sql`update contract_versions set sha256='b' where id=${v!.id}`), /immutable/);
    await expectPg(db.execute(sql`delete from contract_versions where id=${v!.id}`), /cannot be deleted/);
    const [r] = await db.insert(schema.recipients).values({ contractId: c!.id, organisationId: org.id, name: "R", email: "r@example.test" }).returning();
    const [s] = await db.insert(schema.signatures).values({ organisationId: org.id, contractId: c!.id, recipientId: r!.id, method: "TYPED", documentHash: "a", signingSessionId: crypto.randomUUID(), authMethod: "LINK" }).returning();
    await expectPg(db.execute(sql`update signatures set method='DRAWN' where id=${s!.id}`), /append-only/);
  });
  it("field layout freezes after send", async () => {
    const { org, user } = await makeOrg();
    const [c] = await db.insert(schema.contracts).values({ organisationId: org.id, reference: "CTR-T-5", name: "E", createdBy: user.id }).returning();
    const [r] = await db.insert(schema.recipients).values({ contractId: c!.id, organisationId: org.id, name: "R", email: "r@example.test" }).returning();
    const [f] = await db.insert(schema.recipientFields).values({ contractId: c!.id, organisationId: org.id, recipientId: r!.id, key: "sig1", type: "signature", page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }).returning();
    await db.execute(sql`update recipient_fields set x=0.2 where id=${f!.id}`); // DRAFT: allowed
    await db.execute(sql`update contracts set status='SENT' where id=${c!.id}`);
    await expectPg(db.execute(sql`update recipient_fields set x=0.3 where id=${f!.id}`), /frozen/);
    await db.execute(sql`update recipient_fields set value='"v"'::jsonb, filled_at=now() where id=${f!.id}`);
    await expectPg(db.execute(sql`update recipient_fields set value='"other"'::jsonb where id=${f!.id}`), /immutable/);
  });
});
