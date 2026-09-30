import { z } from "zod";

/** Data-driven clause condition. Stored as JSON on a clause version or template selection; no code per combination. */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { eq: [string, string | number | boolean] }
  | { ne: [string, string | number | boolean] }
  | { in: [string, Array<string | number | boolean>] }
  | { truthy: string }
  | { gt: [string, number] }
  | { lt: [string, number] };

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ all: z.array(ConditionSchema).max(20) }).strict(),
  z.object({ any: z.array(ConditionSchema).max(20) }).strict(),
  z.object({ not: ConditionSchema }).strict(),
  z.object({ eq: z.tuple([z.string(), Scalar]) }).strict(),
  z.object({ ne: z.tuple([z.string(), Scalar]) }).strict(),
  z.object({ in: z.tuple([z.string(), z.array(Scalar).max(50)]) }).strict(),
  z.object({ truthy: z.string() }).strict(),
  z.object({ gt: z.tuple([z.string(), z.number()]) }).strict(),
  z.object({ lt: z.tuple([z.string(), z.number()]) }).strict(),
]));

const norm = (x: unknown) => (typeof x === "string" ? x.trim() : x);
const truthy = (x: unknown) => x === true || (typeof x === "string" && !["", "false", "no", "0", "none"].includes(x.trim().toLowerCase())) || (typeof x === "number" && x !== 0);
const same = (a: unknown, b: unknown) => (typeof b === "boolean" ? truthy(a) === b : String(norm(a) ?? "") === String(b));

export function evaluate(c: Condition | null | undefined, ctx: Record<string, unknown>): boolean {
  if (!c) return true;
  if ("all" in c) return c.all.every((x) => evaluate(x, ctx));
  if ("any" in c) return c.any.some((x) => evaluate(x, ctx));
  if ("not" in c) return !evaluate(c.not, ctx);
  if ("eq" in c) return same(ctx[c.eq[0]], c.eq[1]);
  if ("ne" in c) return !same(ctx[c.ne[0]], c.ne[1]);
  if ("in" in c) return c.in[1].some((v) => same(ctx[c.in[0]], v));
  if ("truthy" in c) return truthy(ctx[c.truthy]);
  if ("gt" in c) return Number(ctx[c.gt[0]]) > c.gt[1];
  return Number(ctx[c.lt[0]]) < c.lt[1];
}

export function conditionKeys(c: Condition | null | undefined): string[] {
  if (!c) return [];
  if ("all" in c) return c.all.flatMap(conditionKeys);
  if ("any" in c) return c.any.flatMap(conditionKeys);
  if ("not" in c) return conditionKeys(c.not);
  return [Object.values(c)[0] as unknown as string | [string, unknown]].map((x) => (Array.isArray(x) ? x[0] : x)) as string[];
}
