import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
const msgs: Record<string, unknown> = {};
for (const f of readdirSync(path.join(root, "messages/en"))) msgs[f.replace(".json", "")] = JSON.parse(readFileSync(path.join(root, "messages/en", f), "utf8"));
const has = (key: string) => typeof key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), msgs) === "string";

describe("i18n literal keys used in source exist in en", () => {
  it("resolves every statically-known t('…') key", () => {
    const missing: string[] = [];
    for (const file of walk(path.join(root, "src"))) {
      const src = readFileSync(file, "utf8");
      const decls = [...src.matchAll(/const (\w+) = (?:await )?(?:useTranslations|getTranslations)\(\s*"([^"]+)"\s*\)/g)];
      decls.forEach((m, i) => {
        const [, v, ns] = m;
        // A variable name is often reused per component; scope each declaration to the text before the next same-named one.
        const next = decls.slice(i + 1).find((d) => d[1] === v);
        const scope = src.slice(m.index, next?.index ?? src.length);
        for (const c of scope.matchAll(new RegExp(`(?<![\\w.])${v}\\(\\s*"([^"]+)"`, "g"))) if (!has(`${ns}.${c[1]}`)) missing.push(`${path.relative(root, file)}: ${ns}.${c[1]}`);
      });
    }
    expect(missing).toEqual([]);
  });
});
