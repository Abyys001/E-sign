import data from "./data/matrix.json";

export type MatrixRow = {
  id: string; jurisdiction: string; law: string; topic: string; requirement: string;
  contractImpact: string; customerImpact: string; systemImpact: string; source: string;
  /** Only set when a human/agent actually read the source. `unverified` rows were written from background knowledge. */
  verification: "verified" | "partial" | "unverified";
  researchedAt: string; lastVerified: string | null; notes: string;
};

export const LEGAL_MATRIX = data as MatrixRow[];

export const matrixFor = (jurisdictionPrefix: string) => LEGAL_MATRIX.filter((r) => r.jurisdiction.toLowerCase().startsWith(jurisdictionPrefix.toLowerCase()));

export const matrixStats = () => ({
  total: LEGAL_MATRIX.length,
  verified: LEGAL_MATRIX.filter((r) => r.verification === "verified").length,
  partial: LEGAL_MATRIX.filter((r) => r.verification === "partial").length,
  unverified: LEGAL_MATRIX.filter((r) => r.verification === "unverified").length,
});
