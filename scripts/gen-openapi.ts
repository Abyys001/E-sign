/**
 * Builds docs/contract-platform/openapi.json from the route files themselves, so the inventory (paths, methods, auth mode,
 * required permission) cannot drift from the code. Request/response bodies are described in prose in the API guide, not here.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "src/app/api");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : []; });

type Op = { method: string; auth: "session" | "public"; permission: string | null };
const paths: Record<string, Record<string, unknown>> = {};

for (const file of walk(root).sort()) {
  const src = readFileSync(file, "utf8");
  const route = "/api/" + path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean).map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
  const params = [...route.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
  for (const m of src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*(authed|open)(?:<[^>]*>)?\(\s*(?:"([\w.]+)"|null)?/g)) {
    const op: Op = { method: m[1]!, auth: m[2] === "open" ? "public" : "session", permission: m[3] ?? null };
    (paths[route.replace(/\/$/, "")] ??= {})[op.method.toLowerCase()] = {
      summary: `${op.method} ${route}`,
      security: op.auth === "public" ? [] : [{ session: [] }, { apiKey: [] }],
      ...(op.permission ? { "x-required-permission": op.permission } : {}),
      ...(params.length ? { parameters: params } : {}),
      responses: { "200": { description: "Success" }, "4XX": { $ref: "#/components/responses/Error" }, "5XX": { $ref: "#/components/responses/Error" } },
    };
  }
}

const spec = {
  openapi: "3.1.0",
  info: { title: "Bilit.event E-Sign API", version: "1.0.0", description: "Route inventory generated from source. Bearer API keys carry an explicit permission list; browser sessions additionally require the x-csrf-token header on mutations. Public signing routes authenticate with the signing token plus a browser-bound session cookie." },
  servers: [{ url: "{appUrl}", variables: { appUrl: { default: "http://localhost:3000" } } }],
  paths,
  components: {
    securitySchemes: { session: { type: "apiKey", in: "cookie", name: "bes_session" }, apiKey: { type: "http", scheme: "bearer", description: "bes_live_<prefix>_<secret>" } },
    responses: { Error: { description: "Uniform error envelope", content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {}, correlationId: { type: "string" } } } } } } } } },
  },
};
writeFileSync(path.join(process.cwd(), "docs/contract-platform/openapi.json"), JSON.stringify(spec, null, 2) + "\n");
console.log(`openapi.json: ${Object.keys(paths).length} paths, ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations`);
