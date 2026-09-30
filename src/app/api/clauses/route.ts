import { z } from "zod";
import { authed, query } from "@/server/http";
import { listClauseVersions } from "@/server/clauses/service";
import { CATEGORIES } from "@/server/clauses/types";

const Q = z.object({ language: z.string().default("en"), status: z.string().optional(), q: z.string().max(100).optional(), category: z.string().optional(), jurisdiction: z.string().optional() });

export const GET = authed("templates.view", async ({ req, auth }) => {
  const f = query(req, Q);
  const needle = f.q?.toLowerCase();
  const items = (await listClauseVersions(auth.organisationId, { language: f.language, status: f.status }))
    .filter((c) => (!f.category || c.category === f.category) && (!f.jurisdiction || c.jurisdiction === f.jurisdiction) && (!needle || c.title.toLowerCase().includes(needle) || c.body.toLowerCase().includes(needle) || c.clauseKey.includes(needle)))
    .sort((a, b) => a.clauseKey.localeCompare(b.clauseKey) || a.jurisdiction.localeCompare(b.jurisdiction) || b.version - a.version);
  return { categories: CATEGORIES, items };
});
