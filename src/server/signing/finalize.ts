import { and, asc, eq, isNull } from "drizzle-orm";
import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { db, schema, type Tx } from "@/db";
import { audit } from "../audit";
import { randomId, sha256 } from "../crypto";
import { env } from "@/lib/env";
import { AppError } from "../errors";
import { log } from "../logger";
import { appUrl } from "../messaging/render";
import { getOrgBranding, getOrgSettings } from "../settings";
import { emitWebhook } from "../webhooks/events";
import { contractStakeholders, notifyUsers } from "../notifications";
import { queueEmail } from "../messaging/email";
import { queueSms, smsAvailable } from "../messaging/sms";
import { everyoneRequiredSigned } from "../contracts/routing";
import { lockContract, transition } from "../contracts/service";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { displayedSize, displayedToUser, stampItems, savePdf, loadPdf, appendPdf, type StampItem } from "../kit/pdf/stamp";
import { normalizeRotation, type PageGeometry } from "../kit/pdf/field-coordinates";
import { sha256Bytes } from "../kit/pdf/hash";
import { buildCertificate } from "./certificate";
import type { Locale } from "../messaging/templates";

type FieldRow = typeof schema.recipientFields.$inferSelect;
type Val = { kind: "text"; text: string; imageObjectId?: string } | { kind: "bool"; checked: boolean } | { kind: "signature"; imageObjectId: string; evidenceId: string } | { kind: "attachment"; objectId: string; mime: string };

async function objBytes(orgId: string, id: string): Promise<Buffer> {
  const [o] = await db.select().from(schema.storageObjects).where(and(eq(schema.storageObjects.id, id), eq(schema.storageObjects.organisationId, orgId)));
  if (!o) throw new Error(`storage object ${id} missing`);
  return storage().getBuffer(o.key);
}

const isPng = (b: Buffer) => b[0] === 0x89 && b[1] === 0x50;

/** Word-wrapped text inside a field rectangle (long_text). Same displayed-space geometry as the kit's stamper. */
async function stampWrapped(doc: PDFDocument, f: FieldRow, text: string) {
  const page = doc.getPages()[f.page];
  if (!page) return;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cb = page.getCropBox();
  const g: PageGeometry = { box: [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height], rotate: normalizeRotation(page.getRotation().angle) };
  const { width: pw, height: ph } = displayedSize(g);
  const boxW = f.w * pw, boxH = f.h * ph;
  let size = Math.min(11, boxH * 0.6);
  let lines: string[] = [];
  for (; size >= 5; size -= 0.5) {
    lines = [];
    for (const para of text.split(/\r?\n/)) {
      let cur = "";
      for (const w of para.split(/\s+/)) {
        const t = cur ? `${cur} ${w}` : w;
        if (font.widthOfTextAtSize(t, size) <= boxW - 2) cur = t; else { if (cur) lines.push(cur); cur = w; }
      }
      lines.push(cur);
    }
    if (lines.length * size * 1.15 <= boxH) break;
  }
  lines.forEach((ln, i) => {
    const yFrac = f.y + ((i + 1) * size * 1.15) / ph;
    if (yFrac > f.y + f.h + 1e-6) return;
    const p = displayedToUser(g, f.x, yFrac - (size * 0.25) / ph);
    page.drawText(ln, { x: p.x, y: p.y, size, font, color: rgb(0, 0, 0), rotate: degrees(g.rotate) });
  });
}

/** Stamp every filled field (signatures, typed values, checkboxes) onto `doc`; returns attachments to append. */
async function stampFilledFields(doc: PDFDocument, orgId: string, fields: FieldRow[]) {
  const items: StampItem[] = [];
  const extraPages: Array<{ label: string; obj: string; mime: string }> = [];
  const wrapped: Array<{ f: FieldRow; text: string }> = [];
  for (const f of fields) {
    const v = f.value as Val | null;
    if (!v || !f.filledAt) continue;
    const rect = { page: f.page, x: f.x, y: f.y, width: f.w, height: f.h };
    if (v.kind === "signature") {
      const bytes = await objBytes(orgId, v.imageObjectId);
      items.push({ kind: "image", rect, format: isPng(bytes) ? "png" : "jpg", bytes });
    } else if (v.kind === "bool") items.push({ kind: "checkbox", rect, checked: v.checked });
    else if (v.kind === "text") {
      if (v.imageObjectId) items.push({ kind: "image", rect, format: "png", bytes: await objBytes(orgId, v.imageObjectId) });
      else if (f.type === "long_text") wrapped.push({ f, text: v.text });
      else items.push({ kind: "text", rect, text: v.text });
    } else if (v.kind === "attachment") {
      items.push({ kind: "text", rect, text: `Attachment: ${f.label || f.key} (appended)` });
      extraPages.push({ label: f.label || f.key, obj: v.objectId, mime: v.mime });
    }
  }
  await stampItems(doc, items);
  for (const w of wrapped) await stampWrapped(doc, w.f, w.text);
  return extraPages;
}

/**
 * While a contract is in progress: the signing document with what earlier signers already completed (their signatures,
 * dates and typed values) drawn on, so the next signer sees it. Rendered on the fly; the frozen signing version and the
 * final document are unaffected.
 */
export async function inProgressPdf(orgId: string, sourceBytes: Buffer, fields: FieldRow[]): Promise<Buffer> {
  const done = fields.filter((f) => f.filledAt && f.value);
  if (!done.length) return sourceBytes;
  const doc = await loadPdf(sourceBytes);
  await stampFilledFields(doc, orgId, done);
  return Buffer.from(await savePdf(doc));
}

async function buildFinalPdf(orgId: string, sourceBytes: Buffer, fields: FieldRow[], meta: { certificateId: string; sourceHash: string; reference: string; name: string }) {
  const doc = await loadPdf(sourceBytes);
  const extraPages = await stampFilledFields(doc, orgId, fields);

  for (const a of extraPages) {
    const bytes = await objBytes(orgId, a.obj);
    if (a.mime === "application/pdf") { await appendPdf(doc, bytes); continue; }
    const img = a.mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(`Attachment: ${a.label}`.slice(0, 90), { x: 40, y: 800, size: 11, font });
    const s = Math.min(515 / img.width, 730 / img.height, 1);
    page.drawImage(img, { x: 40, y: 780 - img.height * s, width: img.width * s, height: img.height * s });
  }
  doc.setTitle(meta.name); doc.setSubject(`${meta.reference} · signed with Bilit.event E-Sign`); doc.setProducer("Bilit.event E-Sign"); doc.setCreator("Bilit.event E-Sign");
  doc.setKeywords([`certificate:${meta.certificateId}`, `source-sha256:${meta.sourceHash}`]);
  doc.setCreationDate(new Date()); doc.setModificationDate(new Date());
  return Buffer.from(await savePdf(doc));
}

async function newObject(tx: Tx, orgId: string, area: "final" | "certificate", bytes: Buffer) {
  const key = objectKey(orgId, area);
  const put = await storage().put(key, bytes, "application/pdf");
  const [o] = await tx.insert(schema.storageObjects).values({ organisationId: orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: "application/pdf" }).returning();
  return { obj: o!, key };
}

const deviceText = (d: unknown) => { const x = d as { browser?: string; os?: string; type?: string } | null; return x ? `${x.browser ?? "?"} on ${x.os ?? "?"} (${x.type ?? "?"})` : "—"; };

/**
 * Completion. Idempotent and race-safe:
 *  - heavy work (stamping, certificate, storage writes) happens before the transaction;
 *  - inside the transaction the contract row is locked and `final_version_id` is re-checked, so of two concurrent
 *    finalizers exactly one commits and the loser deletes the objects it wrote.
 */
export async function finalizeContract(contractId: string) {
  const [c0] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, contractId));
  if (!c0) return { status: "missing" as const };
  if (c0.finalVersionId || c0.status === "COMPLETED") return { status: "already" as const };
  const orgId = c0.organisationId;

  const recips = await db.select().from(schema.recipients).where(and(eq(schema.recipients.contractId, contractId), isNull(schema.recipients.deletedAt)));
  if (!everyoneRequiredSigned(recips)) throw new AppError("invalid_state", "Not every required signer has signed.");
  const [ver] = await db.select().from(schema.contractVersions).where(eq(schema.contractVersions.id, c0.signingVersionId!));
  const source = await objBytes(orgId, ver!.storageObjectId);
  if (sha256Bytes(source) !== ver!.sha256) { log.error("finalize.source_hash_mismatch", { contractId }); throw new AppError("internal", "Stored document failed its integrity check."); }
  const fields = await db.select().from(schema.recipientFields).where(eq(schema.recipientFields.contractId, contractId));
  const sigs = await db.select().from(schema.signatures).where(eq(schema.signatures.contractId, contractId));
  const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.contractId, contractId)).orderBy(asc(schema.auditEvents.seq));
  const settings = await getOrgSettings(orgId);
  const brand = await getOrgBranding(orgId);

  const certificateId = `CERT-${randomId(9).toUpperCase().replace(/[-_]/g, "X")}`;
  const verificationId = c0.verificationId ?? randomId(12);
  const finalBytes = await buildFinalPdf(orgId, source, fields, { certificateId, sourceHash: ver!.sha256, reference: c0.reference, name: c0.name });
  const finalHash = sha256(finalBytes);
  const completedAt = new Date();
  const userNames = new Map((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)).map((u) => [u.id, u.name]));
  const byRecipient = new Map(recips.map((r) => [r.id, r]));
  const certBytes = await buildCertificate({
    brand: { orgName: brand.orgName, supportEmail: brand.supportEmail },
    contract: { id: c0.id, reference: c0.reference, name: c0.name, pages: ver!.pageCount, sentAt: c0.sentAt, completedAt },
    certificateId, verificationUrl: appUrl(`/verify/${verificationId}`), sourceHash: ver!.sha256, finalHash, auditHead: events.at(-1)?.hash ?? null,
    timezone: settings.general.timezone, includeIp: settings.signing.includeIpOnCertificate,
    signers: recips.filter((r) => r.role !== "CC").map((r) => {
      const mine = sigs.filter((s) => s.recipientId === r.id);
      const last = mine.at(-1);
      return { name: r.name, email: r.email, role: r.role, company: r.company, authMethod: r.authLevel, status: r.status, signedAt: r.completedAt, ip: last?.ip ?? null, device: deviceText(last?.device), methods: [...new Set(mine.map((s) => s.method))], viewedAt: r.viewedAt, declineReason: r.declineReason };
    }),
    events: events.map((e) => ({ at: e.occurredAt, type: e.eventType, actor: e.recipientId ? byRecipient.get(e.recipientId)?.name ?? "Recipient" : e.userId ? userNames.get(e.userId) ?? "User" : "System" })),
  });

  const written: string[] = [];
  try {
    const out = await db.transaction(async (tx) => {
      const c = await lockContract(tx, orgId, contractId);
      if (c.finalVersionId || c.status === "COMPLETED") return { status: "already" as const };
      const fin = await newObject(tx, orgId, "final", finalBytes); written.push(fin.key);
      const cert = await newObject(tx, orgId, "certificate", certBytes); written.push(cert.key);
      const [last] = await tx.select({ v: schema.contractVersions.version }).from(schema.contractVersions).where(and(eq(schema.contractVersions.contractId, contractId), eq(schema.contractVersions.kind, "FINAL")));
      const [fv] = await tx.insert(schema.contractVersions).values({ contractId, organisationId: orgId, version: (last?.v ?? 0) + 1, kind: "FINAL", storageObjectId: fin.obj.id, sha256: finalHash, pageCount: (await PDFDocument.load(finalBytes)).getPageCount(), pageDims: ver!.pageDims, changeReason: "Final signed document", locked: true }).returning();
      await tx.insert(schema.completionCertificates).values({ organisationId: orgId, contractId, certificateId, storageObjectId: cert.obj.id, finalDocumentHash: finalHash });
      const done = await transition(tx, { orgId }, c, "COMPLETED", { completedAt, finalVersionId: fv!.id, verificationId });
      await audit(tx, { organisationId: orgId, contractId, eventType: "document.final_generated", documentHash: finalHash, metadata: { versionId: fv!.id, sourceHash: ver!.sha256 } });
      await audit(tx, { organisationId: orgId, contractId, eventType: "certificate.generated", documentHash: finalHash, metadata: { certificateId } });
      await audit(tx, { organisationId: orgId, contractId, eventType: "contract.completed", documentHash: finalHash, metadata: { certificateId } });

      // Notify: sender + stakeholders in-app, sender + signers + CC by email (+ SMS where consented), then webhook.
      const stake = await contractStakeholders(tx, orgId, c.createdBy);
      await notifyUsers(tx, orgId, stake, "contract.completed", contractId, { contractName: c.name, reference: c.reference });
      const [sender] = await tx.select({ name: schema.users.name, email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, c.createdBy));
      const baseVars = { sender_name: sender?.name ?? "", contract_name: c.name, contract_reference: c.reference, organisation_name: brand.orgName };
      if (sender) await queueEmail(tx, { orgId, template: "all_signatures_completed", toEmail: sender.email, contractId, locale: sender.locale as Locale, vars: { ...baseVars, recipient_name: sender.name, download_url: appUrl(`/contracts/${contractId}`) }, dedupeKey: `all_signatures_completed:${contractId}` });
      const smsOk = await smsAvailable(orgId);
      if (settings.notifications.emailCompletedToSigners) {
        for (const r of recips.filter((x) => x.role === "CC" || x.status === "COMPLETED")) {
          // Access for recipients without an account: a read-only download link on a dedicated request, valid 90 days.
          const reqId = crypto.randomUUID();
          const { newSigningRequestSecrets } = await import("../crypto");
          const s = newSigningRequestSecrets(reqId);
          await tx.insert(schema.signatureRequests).values({ id: reqId, organisationId: orgId, contractId, recipientId: r.id, tokenHash: s.tokenHash, tokenNonce: s.nonce, status: "USED", expiresAt: new Date(Date.now() + 90 * 86400_000) });
          await queueEmail(tx, { orgId, template: "completed", toEmail: r.email, contractId, recipientId: r.id, vars: { ...baseVars, recipient_name: r.name }, downloadForRequestId: reqId, dedupeKey: `completed:${contractId}:${r.id}` });
          if (smsOk && r.smsConsent && r.phone) await queueSms(tx, { orgId, template: "completed", toPhone: r.phone, contractId, recipientId: r.id, vars: { contract: c.name }, dedupeKey: `sms:completed:${contractId}:${r.id}` }).catch(() => null);
        }
      }
      await emitWebhook(tx, orgId, "contract.completed", { contractId, reference: c.reference, certificateId, finalDocumentHash: finalHash, sourceDocumentHash: ver!.sha256, completedAt: completedAt.toISOString(), verificationUrl: appUrl(`/verify/${verificationId}`) }, `contract.completed:${contractId}`);
      return { status: "completed" as const, certificateId, finalHash, done };
    });
    if (out.status === "already") await Promise.all(written.map((k) => storage().delete(k).catch(() => undefined)));
    return out;
  } catch (e) {
    await Promise.all(written.map((k) => storage().delete(k).catch(() => undefined)));
    throw e;
  }
}
void env;
