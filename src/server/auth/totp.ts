import { generateSecret, generateURI, verifySync } from "otplib";
import { decrypt, encrypt } from "../crypto";

export const newTotpSecret = () => generateSecret();
export const totpUri = (email: string, secret: string) => generateURI({ issuer: "Bilit.event E-Sign", label: email, secret });
export const sealTotp = encrypt;
/** A secret still in enrolment ("pending:") does not count as enabled 2FA. */
export const hasActiveTotp = (v: string | null | undefined): v is string => !!v && !v.startsWith("pending:");
export function verifyTotp(sealed: string | null | undefined, token: string): boolean {
  if (!hasActiveTotp(sealed) || !/^\d{6}$/.test(token)) return false;
  return verifySync({ secret: decrypt(sealed), token, epochTolerance: 30 }).valid;
}
