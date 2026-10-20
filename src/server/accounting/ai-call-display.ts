/**
 * Screen cards for the voice call. Built on the server from the SAME verified tool result the voice model reads, never
 * from what the model says — so the figures on screen and the figures spoken come from one source. Amounts arrive
 * already formatted with their own currency symbol (formatMoney), so the cards never guess a currency.
 */
export type CallCard = {
  kind: "event" | "organiser" | "summary" | "list";
  title: string;
  subtitle?: string;
  meta?: string[]; // date, organiser, status …
  highlight?: { label: string; value: string };
  rows: Array<{ label: string; value: string; strong?: boolean }>;
  note?: string;
  link?: string;
};

type O = Record<string, unknown>;
const arr = (v: unknown) => (Array.isArray(v) ? (v as O[]) : []);
const str = (v: unknown) => (v == null || v === "" ? undefined : String(v));
const cur = (c: unknown) => String(c ?? "").toUpperCase();
const MAX = 6;
const fmtDate = (d: unknown) => {
  const s = str(d);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  return new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const period = (p: unknown) => {
  const x = (p ?? {}) as { from?: string | null; to?: string | null };
  return x.from || x.to ? `${fmtDate(x.from) ?? "start"} – ${fmtDate(x.to) ?? "today"}` : "All time";
};
/** Rows for the given keys that are present. */
const rows = (o: O, keys: Array<[string, string, boolean?]>) => keys.filter(([k]) => str(o[k]) !== undefined).map(([k, label, strong]) => ({ label, value: String(o[k]), ...(strong ? { strong } : {}) }));

export function callCards(tool: string, out: unknown): CallCard[] {
  if (!out || typeof out !== "object" || "error" in (out as O)) return [];
  const o = out as O;
  switch (tool) {
    case "financial_position":
      return arr(o.perCurrency).map((p) => ({ kind: "summary", title: `Financial position — ${cur(p.currency)}`, subtitle: `As of ${fmtDate(o.asOf) ?? "now"}`, meta: [String(p.status ?? "")].filter(Boolean),
        highlight: { label: "Cash remaining after all liabilities", value: String(p.cashRemainingAfterAllLiabilities) },
        rows: rows(p, [["cash", "Cash (Stripe + Wise)", true], ["cashAvailableNow", "Available now"], ["cashPendingInStripe", "Pending in Stripe"], ["owedToOrganisers", "Owed to organisers"], ["owedToOrganisersDueNow", "…due now"], ["otherLiabilities", "Other liabilities"], ["receivables", "Receivables"], ["shortfall", "Shortfall"]]), link: "/accounting/position" }));
    case "sales_summary":
      return arr(o.totals).map((t) => ({ kind: "summary", title: `Sales — ${cur(t.currency)}`, subtitle: period(o.period), meta: [`${t.tickets ?? 0} tickets`, `${t.orders ?? 0} orders`],
        highlight: { label: "Bilit revenue", value: String(t.bilitRevenue) },
        rows: rows(t, [["grossTicketSales", "Gross ticket sales", true], ["refunds", "Refunds"], ["netTicketSales", "Net ticket sales"], ["bookingFees", "Booking fees"], ["stripeFeesBorneByBilit", "Stripe fees (Bilit)"], ["eventContributionProfit", "Event contribution profit", true], ["organiserRemaining", "Still owed to organisers"]]), link: "/accounting/overview" }));
    case "profit_and_loss":
      return arr(o.perCurrency).map((p) => ({ kind: "summary", title: `Profit and loss — ${cur(p.currency)}`, subtitle: period(o.period),
        highlight: { label: "Net profit", value: String(p.netProfit) },
        rows: rows(p, [["revenue", "Revenue", true], ["directCosts", "Direct costs"], ["grossProfit", "Gross profit", true], ["operatingExpenses", "Operating expenses"]]), link: "/accounting/books" }));
    case "compare_periods": {
      const c = (o.current ?? {}) as O, pr = (o.previous ?? {}) as O;
      return arr(o.perCurrency).map((p) => {
        const line = (k: string, label: string) => { const x = (p[k] ?? {}) as O; return x.current ? { label, value: `${x.current} vs ${x.previous} (${String(x.change).startsWith("-") ? "" : "+"}${x.change}${x.changePct != null ? `, ${x.changePct}%` : ""})` } : null; };
        const r = [line("grossTicketSales", "Gross sales"), line("bilitRevenue", "Bilit revenue"), line("eventContributionProfit", "Contribution profit"), line("companyNetProfit", "Net profit"), line("stripeFees", "Stripe fees")].filter(Boolean) as CallCard["rows"];
        return { kind: "list" as const, title: `Comparison — ${cur(p.currency)}`, subtitle: `${period(c)} vs ${period(pr)}`, rows: r };
      });
    }
    case "events_breakdown": {
      const evs = arr(o.events);
      const cards: CallCard[] = evs.slice(0, MAX).map((e) => ({ kind: "event", title: String(e.name ?? e.code), subtitle: str(e.code), meta: [fmtDate(e.date), str(e.organiser), str(e.status)].filter(Boolean) as string[],
        highlight: { label: "Still owed to organiser", value: String(e.organiserRemaining) },
        rows: rows(e, [["gross", "Ticket sales (gross)", true], ["refunds", "Refunds"], ["bilitRevenue", "Bilit revenue"], ["stripeFeesBilit", "Stripe fees (Bilit)"], ["contributionProfit", "Contribution profit", true], ["organiserDue", "Due to organiser"], ["organiserPaid", "Paid to organiser"]]),
        link: str(e.link) }));
      if (evs.length > 1) for (const t of arr(o.totalsPerCurrency)) cards.push({ kind: "summary", title: `All ${evs.length} events — ${cur(t.currency)}`, subtitle: period(o.period), highlight: { label: "Contribution profit", value: String(t.contributionProfit) }, rows: rows(t, [["gross", "Ticket sales (gross)"], ["bilitRevenue", "Bilit revenue"], ["organiserRemaining", "Still owed to organisers"]]), ...(evs.length > MAX ? { note: `Showing ${MAX} of ${evs.length} events` } : {}) });
      return cards;
    }
    case "organiser_settlements":
      return arr(o.organisers).slice(0, MAX).map((s) => ({ kind: "organiser", title: String(s.organiser), subtitle: cur(s.currency), meta: [`${s.events ?? 0} events`, str(s.status), s.lastPayment ? `last paid ${fmtDate(s.lastPayment)}` : undefined].filter(Boolean) as string[],
        highlight: { label: "Remaining to pay", value: String(s.remaining) },
        rows: rows(s, [["due", "Due", true], ["paid", "Paid"], ["pending", "Pending"], ["dueNow", "Due now"], ["dueLater", "Due later"]]), link: str(s.link) }));
    case "organiser_payments": {
      const pays = arr(o.payments);
      return [{ kind: "list", title: "Organiser payments", subtitle: `${pays.length} payment${pays.length === 1 ? "" : "s"}`,
        rows: [...arr(o.paidTotals).map((t) => ({ label: `Total paid — ${cur(t.currency)}`, value: String(t.paid), strong: true })),
          ...pays.slice(0, 8).map((p) => ({ label: `${fmtDate(p.date)} · ${p.organiser}${p.event && p.event !== "whole organiser" ? ` · ${p.event}` : ""}${p.status && p.status !== "PAID" ? ` · ${p.status}` : ""}`, value: String(p.amount) }))],
        ...(pays.length > 8 ? { note: `Showing 8 of ${pays.length}` } : {}), link: "/accounting/payments" }];
    }
    case "performance_series":
      return [{ kind: "list", title: `Performance by ${String(o.granularity ?? "month")}`, rows: arr(o.rows).slice(-12).map((r) => ({ label: `${r.period} · ${cur(r.currency)}`, value: `${r.grossSales} sales · ${r.bilitProfit} profit` })) }];
    case "expenses":
      return arr(o.perCurrency).map((b) => ({ kind: "summary", title: `Expenses — ${cur(b.currency)}`, highlight: { label: "Total expenses", value: String(b.totalExpenses) },
        rows: [...arr(b.accounts).slice(0, 5).map((x) => ({ label: String(x.account), value: String(x.amount) })), ...rows(b, [["unpaidSupplierInvoices", "Unpaid supplier invoices", true], ["overdue", "Overdue"]])] }));
    case "stripe_fees":
      return arr(o.perCurrency).map((f) => ({ kind: "summary", title: `Stripe fees — ${cur(f.currency)}`, highlight: { label: "Borne by Bilit", value: String(f.borneByBilit) },
        rows: [...rows(f, [["onEventSales", "Total on event sales", true], ["rechargedToOrganisers", "Recharged to organisers"]]), ...(f.feePctOfGross != null ? [{ label: "Fee % of gross", value: `${f.feePctOfGross}%` }] : [])] }));
    case "cash_forecast":
      return arr(o.perCurrency).map((f) => ({ kind: "summary", title: `Cash forecast — ${cur(f.currency)}`, subtitle: "Estimate", highlight: { label: "Available now", value: String(f.availableNow) },
        rows: [...arr(f.horizons).map((h) => ({ label: `Free cash in ${h.days} days (${fmtDate(h.date)})`, value: String(h.freeCash) })), ...(((f.lowestPoint ?? {}) as O).freeCash ? [{ label: `Lowest point (${fmtDate(((f.lowestPoint ?? {}) as O).date)})`, value: String(((f.lowestPoint ?? {}) as O).freeCash), strong: true }] : [])],
        note: f.firstShortfallDate ? `First shortfall: ${fmtDate(f.firstShortfallDate)}` : "Estimate — excludes future ticket sales" }));
    case "reconciliation_status":
      return [{ kind: "list", title: "Reconciliation", rows: arr(o.stripeVsBooks).map((x) => ({ label: `Stripe vs books — ${cur(x.currency)}`, value: `difference ${x.difference}` })), link: "/accounting/reconciliation" }];
    case "unreconciled_transactions": {
      const items = arr(o.items);
      return [{ kind: "list", title: "Transactions to reconcile", subtitle: `${o.total ?? items.length} open`, rows: items.slice(0, 6).map((x) => ({ label: `${fmtDate(x.date)} · ${x.kind}${x.eventCode ? ` · ${x.eventCode}` : ""} · ${x.status}`, value: String(x.amount) })), link: "/accounting/reconciliation" }];
    }
    case "calculate":
      return [{ kind: "summary", title: "Calculation", highlight: { label: "Result", value: String(o.result) }, rows: arr(o.lines).map((l) => ({ label: String(l.label), value: String(l.amount) })) }];
    default: return [];
  }
}
