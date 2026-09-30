import { createHash } from 'node:crypto';
import { canonicalJson } from '@/server/canonical';

export type SignatureMode = 'typed' | 'drawn' | 'uploaded';
export type AuthLevel = 'none' | 'email_otp' | 'sms_otp' | 'passcode' | 'kyc';

/**
 * Evidence of a signing act. This is a record of *what happened*, not a cryptographic signature: it has no
 * key material and proves nothing by itself. Its value is being stored immutably, hashed into the audit chain and
 * printed on the completion certificate. Cryptographic sealing is a separate concern (backend/trust-services).
 */
export interface SignatureEvidence {
  id: string;
  tenantId: string;
  contractId: string;
  recipientId: string;
  fieldId: string;
  mode: SignatureMode;
  /** SHA-256 hex of the signature image bytes (drawn/uploaded/rendered typed). Image itself lives in object storage. */
  imageHash: string;
  /** Exactly what the signer typed, when mode = typed. */
  typedText: string | null;
  identity: { name: string; email: string; claims?: Record<string, string> };
  authLevel: AuthLevel;
  ip: string | null;
  userAgent: string | null;
  signedAt: Date;
  consentId: string;
  /** SHA-256 hex of the exact document version the signer saw. */
  documentHash: string;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;

export function assertEvidence(e: SignatureEvidence): void {
  if (!HEX64.test(e.imageHash) || !HEX64.test(e.documentHash)) throw new Error('hashes must be sha-256 hex');
  if (e.mode === 'typed' && !(e.typedText && e.typedText.trim())) throw new Error('typed signature requires typedText');
  if (e.mode !== 'typed' && e.typedText !== null) throw new Error('typedText only valid for typed signatures');
  if (!e.consentId) throw new Error('consent is required before a signature');
  if (Number.isNaN(e.signedAt.getTime())) throw new Error('invalid signedAt');
}

/** Stable digest of the evidence record: goes into the audit event metadata and the certificate. */
export function evidenceHash(e: SignatureEvidence): string {
  assertEvidence(e);
  return sha256Hex(canonicalJson(e));
}

export function hashesDocument(e: SignatureEvidence, documentBytes: Uint8Array): boolean {
  return sha256Hex(documentBytes) === e.documentHash;
}
