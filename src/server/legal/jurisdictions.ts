/**
 * Jurisdiction profiles drive clause variants, warnings, execution requirements and review flags.
 * Selecting one does NOT make a contract compliant; it only selects drafting variants and surfaces things a lawyer must confirm.
 * Warnings are prompts for counsel, cross-referenced with the research matrix (docs/legal/research-matrix.md).
 */
export type Region = "UK" | "EU" | "AE" | "US" | "OTHER";

export type JurisdictionProfile = {
  code: string;
  label: string;
  region: Region;
  /** Governing-law wording inserted into {{governing_law}}. */
  governingLaw: string;
  /** Default forum wording for {{jurisdiction}}. */
  forum: string;
  /** True when drafting variants for this jurisdiction exist in the library (otherwise generic variants + a review flag). */
  hasVariants: boolean;
  /** Minimum e-signature level the profile expects for ordinary commercial agreements. Consumer-facing terms are separate. */
  ordinarySignatureLevel: "SES" | "AES" | "QES";
  warnings: string[];
};

export const JURISDICTIONS: JurisdictionProfile[] = [
  { code: "ENG", label: "England & Wales", region: "UK", governingLaw: "the laws of England and Wales", forum: "the courts of England and Wales", hasVariants: true, ordinarySignatureLevel: "SES",
    warnings: ["Deeds require witnessing/attestation formalities; this platform does not execute deeds.", "Consumer-facing ticket terms and fee disclosures (CRA 2015, DMCC Act 2024) must be reviewed separately."] },
  { code: "SCO", label: "Scotland", region: "UK", governingLaw: "the laws of Scotland", forum: "the courts of Scotland", hasVariants: true, ordinarySignatureLevel: "SES",
    warnings: ["Scots-law writing/authentication formalities differ from England; confirm the execution method for this transaction.", "Consumer-facing ticket terms require separate review."] },
  { code: "NIR", label: "Northern Ireland", region: "UK", governingLaw: "the laws of Northern Ireland", forum: "the courts of Northern Ireland", hasVariants: true, ordinarySignatureLevel: "SES",
    warnings: ["Confirm any Northern Ireland-specific formalities and consumer rules.", "Consumer-facing ticket terms require separate review."] },
  { code: "DE", label: "Germany", region: "EU", governingLaw: "the laws of the Federal Republic of Germany", forum: "the courts of Germany", hasVariants: false, ordinarySignatureLevel: "SES",
    warnings: ["Statutory written-form (Schriftform) requirements can demand a qualified electronic signature; confirm none apply.", "German-law standard-terms (AGB) control applies to pre-formulated terms; legal review recommended."] },
  { code: "FR", label: "France", region: "EU", governingLaw: "the laws of France", forum: "the courts of France", hasVariants: false, ordinarySignatureLevel: "SES",
    warnings: ["French rules on ticket resale and consumer terms apply; legal review recommended.", "Confirm language requirements for consumer-facing documents."] },
  { code: "NL", label: "Netherlands", region: "EU", governingLaw: "the laws of the Netherlands", forum: "the courts of the Netherlands", hasVariants: false, ordinarySignatureLevel: "SES",
    warnings: ["Dutch general-terms rules (algemene voorwaarden) may affect enforceability; legal review recommended."] },
  { code: "ES", label: "Spain", region: "EU", governingLaw: "the laws of Spain", forum: "the courts of Spain", hasVariants: false, ordinarySignatureLevel: "SES",
    warnings: ["Spanish consumer and ticket-resale rules apply; legal review recommended."] },
  { code: "AE", label: "United Arab Emirates", region: "AE", governingLaw: "the laws of the United Arab Emirates as applied in the Emirate of Dubai", forum: "the courts of the Emirate of Dubai", hasVariants: true, ordinarySignatureLevel: "SES",
    warnings: ["Confirm the required e-signature reliability level and any document categories excluded from e-signature.", "Confirm language (Arabic) requirements for court use, and whether DIFC/ADGM or arbitration is intended.", "Confirm event permit and advertising licence requirements with the relevant Emirate authority."] },
  { code: "US-NY", label: "New York (USA)", region: "US", governingLaw: "the laws of the State of New York, without regard to conflict-of-laws principles", forum: "the state and federal courts located in New York County, New York", hasVariants: true, ordinarySignatureLevel: "SES",
    warnings: ["New York ticket-resale and refund statutes and the FTC fee rule may apply; legal review recommended.", "Confirm ESIGN/ESRA exceptions do not apply."] },
  { code: "US-CA", label: "California (USA)", region: "US", governingLaw: "the laws of the State of California, without regard to conflict-of-laws principles", forum: "the state and federal courts located in California", hasVariants: true, ordinarySignatureLevel: "SES",
    warnings: ["California ticket refund/fee-disclosure statutes and the FTC fee rule may apply; legal review recommended.", "Confirm ESIGN/UETA exceptions do not apply."] },
  { code: "OTHER", label: "Other (specify)", region: "OTHER", governingLaw: "{{governing_law_custom}}", forum: "{{jurisdiction_custom}}", hasVariants: false, ordinarySignatureLevel: "SES",
    warnings: ["Non-standard jurisdiction: no drafting variants are provided. Qualified counsel must review before signature."] },
];

const BY_CODE = new Map(JURISDICTIONS.map((j) => [j.code, j]));
export const jurisdictionByCode = (code: string) => BY_CODE.get(code);
export const isKnownJurisdiction = (code: string) => BY_CODE.has(code);
