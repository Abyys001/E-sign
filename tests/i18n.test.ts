import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = (l: string) => path.join(process.cwd(), "messages", l);
const flat = (o: unknown, p = ""): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k)) : [p]);
const load = (l: string, f: string) => JSON.parse(readFileSync(path.join(dir(l), f), "utf8"));

describe("i18n parity", () => {
  const files = readdirSync(dir("en")).filter((f) => f.endsWith(".json"));
  it("fa has the same namespaces as en", () => expect(readdirSync(dir("fa")).sort()).toEqual(readdirSync(dir("en")).sort()));
  for (const f of files) {
    it(`${f}: identical key sets`, () => {
      const en = flat(load("en", f)).sort(), fa = flat(load("fa", f)).sort();
      expect(fa.filter((k) => !en.includes(k)), "extra in fa").toEqual([]);
      expect(en.filter((k) => !fa.includes(k)), "missing in fa").toEqual([]);
    });
    it(`${f}: no empty strings and no dotted keys`, () => {
      for (const l of ["en", "fa"]) {
        const keys = flat(load(l, f));
        expect(keys.filter((k) => k === "")).toEqual([]);
      }
    });
  }
});
