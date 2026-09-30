import { writeFileSync } from "node:fs";
import { LEGAL_MATRIX, matrixStats } from "../src/server/legal/matrix";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const s = matrixStats();
const groups = [...new Set(LEGAL_MATRIX.map((r) => r.jurisdiction))];
let md = `# Legal research matrix\n\n> Technical/legal-research support for review by qualified counsel. **Not legal advice; the platform is not represented as compliant.**\n>\n> Research date 2026-09-29. Rows: ${s.total} (verified by reading the source: ${s.verified}; partially: ${s.partial}; **unverified, written from background knowledge: ${s.unverified}**). Most official sites blocked automated fetching (HTTP 403 / bot challenges). Treat every \`unverified\` row as a lead to confirm, not a fact. "Last Verified" is empty unless a source was actually read.\n\n`;
for (const g of groups) {
  md += `## ${g}\n\n| ID | Law / Regulation | Topic | Relevant requirement | Contract impact | Customer-facing impact | System impact | Source | Status | Last verified | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of LEGAL_MATRIX.filter((x) => x.jurisdiction === g))
    md += `| ${r.id} | ${esc(r.law)} | ${esc(r.topic)} | ${esc(r.requirement)} | ${esc(r.contractImpact)} | ${esc(r.customerImpact)} | ${esc(r.systemImpact)} | ${r.source} | ${r.verification} | ${r.lastVerified ?? "—"} | ${esc(r.notes)} |\n`;
  md += "\n";
}
writeFileSync("docs/legal/research-matrix.md", md);
console.log(`wrote docs/legal/research-matrix.md (${s.total} rows)`);
