"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";

export type Sel = { clauseKey: string; versionId: string; required?: boolean };
export type LibClause = { id: string; clauseKey: string; category: string; title: string; version: number; jurisdiction: string; body: string; reviewStatus: string };

/** One row per clause key. The pinned version is chosen for the template's jurisdiction, falling back to the generic variant. */
export function ClauseSelector({ library, jurisdiction, region, selection, onChange, readOnly }: { library: LibClause[]; jurisdiction: string; region: string; selection: Sel[]; onChange: (s: Sel[]) => void; readOnly?: boolean }) {
  const t = useTranslations("intake.selector");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [only, setOnly] = useState<"" | "selected">("");
  const [view, setView] = useState<LibClause | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, LibClause[]>();
    for (const c of library) m.set(c.clauseKey, [...(m.get(c.clauseKey) ?? []), c]);
    return [...m.entries()].map(([key, vs]) => ({ key, vs: vs.sort((a, b) => b.version - a.version), title: vs[0]!.title, category: vs[0]!.category }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
  }, [library]);
  const cats = [...new Set(groups.map((g) => g.category))];
  const chosen = new Map(selection.map((s) => [s.clauseKey, s]));
  // Mirrors the server's pickVariant scoring: exact > region > prefix > ANY.
  const score = (j: string) => (j === jurisdiction ? 4 : j === region ? 3 : jurisdiction.startsWith(`${j}-`) ? 2 : j === "ANY" ? 1 : 0);
  const best = (vs: LibClause[]) => [...vs].sort((a, b) => score(b.jurisdiction) - score(a.jurisdiction) || b.version - a.version)[0]!;
  const rows = groups.filter((g) => (!cat || g.category === cat) && (only !== "selected" || chosen.has(g.key)) && (!q || `${g.title} ${g.key}`.toLowerCase().includes(q.toLowerCase())));
  const toggle = (g: (typeof groups)[number]) => onChange(chosen.has(g.key) ? selection.filter((s) => s.clauseKey !== g.key) : [...selection, { clauseKey: g.key, versionId: best(g.vs).id }]);
  const setVersion = (key: string, versionId: string) => onChange(selection.map((s) => (s.clauseKey === key ? { ...s, versionId } : s)));
  const all = (on: boolean) => onChange(on ? rows.map((g) => chosen.get(g.key) ?? { clauseKey: g.key, versionId: best(g.vs).id }).concat(selection.filter((s) => !rows.some((r) => r.key === s.clauseKey))) : selection.filter((s) => !rows.some((r) => r.key === s.clauseKey) || s.required));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute start-3 top-3 size-4 text-muted" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="ps-9" /></div>
        <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("category")} className="w-44"><option value="">{t("allCategories")}</option>{cats.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
        <Select value={only} onChange={(e) => setOnly(e.target.value as "" | "selected")} aria-label={t("show")} className="w-36"><option value="">{t("showAll")}</option><option value="selected">{t("showSelected")}</option></Select>
        {!readOnly && <><Button size="sm" onClick={() => all(true)}>{t("selectAll")}</Button><Button size="sm" onClick={() => all(false)}>{t("clear")}</Button></>}
        <span className="num text-sm text-muted">{t("count", { n: selection.length })}</span>
      </div>
      <TableWrap><Table><thead><tr><Th><span className="sr-only">{t("selected")}</span></Th><Th>{t("clause")}</Th><Th>{t("version")}</Th><Th>{t("review")}</Th></tr></thead>
        <tbody>{rows.map((g) => {
          const s = chosen.get(g.key); const cur = g.vs.find((v) => v.id === s?.versionId) ?? best(g.vs);
          return (
            <Tr key={g.key}>
              <Td><Checkbox label={<span className="sr-only">{g.title}</span>} disabled={readOnly} checked={!!s} onChange={() => toggle(g)} /></Td>
              <Td><button type="button" onClick={() => setView(cur)} className="text-start font-medium hover:underline">{g.title}</button><span className="block text-xs text-muted">{g.category} · {g.key}</span></Td>
              <Td>{s && g.vs.length > 1 ? <Select aria-label={t("version")} disabled={readOnly} value={s.versionId} onChange={(e) => setVersion(g.key, e.target.value)} className="h-9 w-40">{g.vs.map((v) => <option key={v.id} value={v.id}>{v.jurisdiction} · v{v.version}</option>)}</Select> : <span className="num text-muted">{cur.jurisdiction} · v{cur.version}</span>}</Td>
              <Td className="text-muted">{t(`reviewState.${cur.reviewStatus}` as never)}</Td>
            </Tr>);
        })}</tbody></Table></TableWrap>
      <Modal open={!!view} onClose={() => setView(null)} size="lg" title={view?.title ?? ""} description={view ? `${view.clauseKey} · ${view.jurisdiction} · v${view.version}` : undefined} footer={<Button onClick={() => setView(null)}>{t("close")}</Button>}>
        {view && <p className="whitespace-pre-wrap text-sm leading-relaxed">{view.body}</p>}
      </Modal>
    </Card>
  );
}
