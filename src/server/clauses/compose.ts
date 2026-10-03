import { evaluate, type Condition } from "./condition";
import { CATEGORIES } from "./types";
import { findVariables, renderText, unresolvedIn, mergeDefs, type VariableDef, type VariableValues } from "../variables/registry";

export type ClauseVersionRow = {
  id: string; clauseKey: string; category: string; module: string; title: string; version: number;
  language: string; jurisdiction: string; body: string; reviewStatus: string; status: string; condition: Condition | null;
};
export type SelectionItem = { clauseKey: string; versionId: string; required?: boolean; condition?: Condition | null };

export type ComposedSection = { category: string; number: number; clauses: Array<{ number: string; clauseKey: string; versionId: string; version: number; title: string; body: string; reviewStatus: string }> };
export type ComposeResult = {
  sections: ComposedSection[];
  included: Array<{ clauseKey: string; versionId: string; version: number; reviewStatus: string }>;
  excluded: Array<{ clauseKey: string; reason: "condition" | "unselected" }>;
  /** variable -> clause keys that need it; non-empty means the contract MUST NOT be finalised. */
  unresolved: Record<string, string[]>;
};

const jurisdictionRank = (variant: string, jurisdiction: string): number => {
  if (variant === jurisdiction) return 3;
  if (jurisdiction.startsWith(`${variant}-`)) return 2;
  if (variant === "ANY") return 1;
  return 0;
};

/** Choose the best published variant of a clause for a jurisdiction: exact > region prefix (US matches US-NY; UK matches ENG/SCO/NIR via `regionOf`) > ANY; latest version wins. */
export function pickVariant(candidates: ClauseVersionRow[], jurisdiction: string, region: string, language: string): ClauseVersionRow | null {
  const ok = candidates.filter((c) => c.language === language && c.status === "PUBLISHED");
  const score = (c: ClauseVersionRow) => (c.jurisdiction === jurisdiction ? 4 : c.jurisdiction === region ? 3 : c.jurisdiction === "ANY" ? 1 : jurisdictionRank(c.jurisdiction, jurisdiction));
  return ok.filter((c) => score(c) > 0).sort((a, b) => score(b) - score(a) || b.version - a.version)[0] ?? null;
}

/**
 * Compose the contract body from pinned clause versions. Nothing outside `selection` can appear.
 * Clauses whose conditions evaluate false are excluded (so unselected obligations are never invented).
 */
export function composeClauses(args: {
  selection: SelectionItem[];
  versions: Map<string, ClauseVersionRow>;
  values: VariableValues;
  customDefs?: VariableDef[];
  optionalVars?: ReadonlySet<string>;
  /** Keep sections in selection order (agreements with their own fixed numbering) instead of the standard category order. */
  keepOrder?: boolean;
}): ComposeResult {
  const defs = mergeDefs(args.customDefs);
  const optional = args.optionalVars ?? new Set<string>();
  const unresolved: Record<string, string[]> = {};
  const excluded: ComposeResult["excluded"] = [];
  const included: ComposeResult["included"] = [];
  const byCat = new Map<string, ComposedSection["clauses"]>();

  for (const sel of args.selection) {
    const v = args.versions.get(sel.versionId);
    if (!v) throw new Error(`Selected clause version not found: ${sel.clauseKey}`);
    if (v.clauseKey !== sel.clauseKey) throw new Error(`Clause version ${sel.versionId} does not belong to ${sel.clauseKey}`);
    if (!evaluate(sel.condition, args.values) || !evaluate(v.condition, args.values)) { excluded.push({ clauseKey: sel.clauseKey, reason: "condition" }); continue; }
    for (const k of unresolvedIn(v.body, args.values, optional)) (unresolved[k] ??= []).push(v.clauseKey);
    let body = "";
    try { body = renderText(v.body, args.values, defs, optional); } catch { body = v.body; }
    const list = byCat.get(v.category) ?? [];
    list.push({ number: "", clauseKey: v.clauseKey, versionId: v.id, version: v.version, title: v.title, body, reviewStatus: v.reviewStatus });
    byCat.set(v.category, list);
    included.push({ clauseKey: v.clauseKey, versionId: v.id, version: v.version, reviewStatus: v.reviewStatus });
  }

  const order = [...CATEGORIES] as string[];
  const sections = [...byCat.entries()]
    .sort((a, b) => args.keepOrder ? 0 : (order.indexOf(a[0]) === -1 ? 99 : order.indexOf(a[0])) - (order.indexOf(b[0]) === -1 ? 99 : order.indexOf(b[0])))
    .map(([category, clauses], i): ComposedSection => ({ category, number: i + 1, clauses: clauses.map((c, j) => ({ ...c, number: `${i + 1}.${j + 1}` })) }));
  return { sections, included, excluded, unresolved };
}

/** Variables the selected, condition-passing clauses need; used by the intake builder to know which questions are required. */
export function requiredVariables(selection: SelectionItem[], versions: Map<string, ClauseVersionRow>, values: VariableValues): string[] {
  const out = new Set<string>();
  for (const sel of selection) {
    const v = versions.get(sel.versionId);
    if (!v || !evaluate(sel.condition, values) || !evaluate(v.condition, values)) continue;
    for (const k of findVariables(v.body)) out.add(k);
  }
  return [...out];
}
