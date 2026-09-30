import { jurisdictionByCode } from "./jurisdictions";

export const SIGNATURE_LEVELS = ["SES", "AES", "QES"] as const;
export type SignatureLevel = (typeof SIGNATURE_LEVELS)[number];
export const IDENTITY_METHODS = ["NONE", "EMAIL", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"] as const;

/** What the platform can actually do today. Never advertise more than this. */
export const PLATFORM_CAPABILITIES = {
  levels: ["SES"] as SignatureLevel[],
  witness: false,
  physicalPresence: false,
  certificate: false,
  timestamp: true, // server-side audit timestamps + hash-chain; NOT an RFC 3161 trusted timestamp
  identity: ["NONE", "EMAIL", "EMAIL_OTP", "SMS_OTP", "PASSCODE", "ACCOUNT"] as string[],
};

/** Execution requirements chosen for a template/contract (configurable per jurisdiction by the authorised user). */
export type ExecutionRequirements = {
  level: SignatureLevel;
  identity: (typeof IDENTITY_METHODS)[number];
  witness: boolean;
  physicalPresence: boolean;
  deed: boolean;
  certificateRequired: boolean;
  trustedTimestampRequired: boolean;
  additionalFormalities: string[];
};

export const DEFAULT_EXECUTION: ExecutionRequirements = {
  level: "SES", identity: "EMAIL_OTP", witness: false, physicalPresence: false, deed: false,
  certificateRequired: false, trustedTimestampRequired: false, additionalFormalities: [],
};

export const FORMALITIES_FLAG = "Additional execution formalities required.";

export type SigningDecision = {
  supported: boolean;
  /** When false, automatic signing (Option A) must stop and the contract needs a manual/other execution route. */
  autoSignAllowed: boolean;
  unsupported: string[];
  flag: string | null;
};

/** Decide whether the platform can execute this workflow. Never downgrades or fakes an advanced/qualified signature. */
export function evaluateSigningPolicy(req: ExecutionRequirements, jurisdiction: string, caps = PLATFORM_CAPABILITIES): SigningDecision {
  const unsupported: string[] = [];
  const profile = jurisdictionByCode(jurisdiction);
  const needed: SignatureLevel = rank(req.level) >= rank(profile?.ordinarySignatureLevel ?? "SES") ? req.level : (profile?.ordinarySignatureLevel ?? "SES");
  if (!caps.levels.includes(needed)) unsupported.push(`${needed === "QES" ? "Qualified" : "Advanced"} electronic signature`);
  if (req.witness && !caps.witness) unsupported.push("Witness attestation");
  if (req.deed) unsupported.push("Execution as a deed");
  if (req.physicalPresence && !caps.physicalPresence) unsupported.push("Physical presence");
  if (req.certificateRequired && !caps.certificate) unsupported.push("Signer certificate");
  if (req.identity !== "NONE" && !caps.identity.includes(req.identity)) unsupported.push(`Identity verification (${req.identity})`);
  for (const f of req.additionalFormalities) unsupported.push(f);
  return { supported: unsupported.length === 0, autoSignAllowed: unsupported.length === 0, unsupported, flag: unsupported.length ? FORMALITIES_FLAG : null };
}

const rank = (l: SignatureLevel) => SIGNATURE_LEVELS.indexOf(l);
