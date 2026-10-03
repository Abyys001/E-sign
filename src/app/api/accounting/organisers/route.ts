import { z } from "zod";
import { acct } from "@/server/accounting/http";
import { body, query } from "@/server/http";
import { Pagination } from "@/server/api";
import { createOrganiser, OrganiserInput, organiserView } from "@/server/accounting/entities";
import { listOrganisers } from "@/server/accounting/queries";
import { eventFinancials } from "@/server/accounting/finance";

const Q = Pagination.extend({ q: z.string().trim().max(120).optional(), active: z.enum(["true", "false"]).optional() }).passthrough();

/** Organisers with event count and, per currency, Bilit's profit (after Stripe fees) and the balance still to pay. */
export const GET = acct("accounting.view", async ({ req, auth, mode }) => {
  const q = query(req, Q);
  const [list, events] = await Promise.all([
    listOrganisers(auth.organisationId, { q: q.q, active: q.active === undefined ? undefined : q.active === "true" }, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
    eventFinancials(auth.organisationId, mode, {}),
  ]);
  const money = (id: string) => {
    const by = new Map<string, { currency: string; profit: number; remaining: number; gross: number }>();
    for (const e of events) if (e.organiserId === id && (e.grossSales || e.organiserDue || e.bilitProfit)) {
      const m = by.get(e.currency) ?? { currency: e.currency, profit: 0, remaining: 0, gross: 0 };
      m.profit += e.bilitProfit; m.remaining += e.remaining; m.gross += e.grossSales; by.set(e.currency, m);
    }
    return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  };
  return { ...list, items: list.items.map((o) => ({ ...o, money: money(o.id) })), page: q.page, pageSize: q.pageSize, mode };
});

/** Organisers are created by an administrator only — never automatically from Stripe customers. */
export const POST = acct("accounting.manage", async ({ req, auth, ctx }) =>
  organiserView(await createOrganiser({ orgId: auth.organisationId, userId: auth.user.id, ctx }, await body(req, OrganiserInput))));
