import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db, schema } from "@/db";
import { formatMoney } from "@/lib/money";
import { AppError } from "../errors";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import { isLive, type Mode } from "./core";
import { organiserFinancials, totalsByCurrency } from "./finance";
import { syncCashback } from "./cashback";
import { getInvoiceSettings, registrationLines } from "./invoices";
import { organiserContracts } from "./organiser-contracts";

type Range = { from?: string | null; to?: string | null; eventIds?: string[] | null; /** one-event report: don't apply payments on account to it, show the organiser's whole account instead */ eventReport?: boolean };

/**
 * Settlement statement for a chosen set of events (e.g. the finished ones). Per currency: due on those events, payments
 * tagged to them, and payments made "on account" (not tied to any event) — those are applied to this statement, as the
 * owner settles them. Balance = due − tagged − on account; negative means the organiser has been paid more.
 */
export type StatementLine = { currency: string; due: number; paidOnEvents: number; paidOnAccount: number; balance: number };
export function statementLines(events: Array<{ currency: string; organiserDue: number; organiserPaid: number }>, onAccount: Array<{ currency: string; amount: number }>): StatementLine[] {
  const by = new Map<string, StatementLine>();
  const get = (c: string) => by.get(c) ?? (by.set(c, { currency: c, due: 0, paidOnEvents: 0, paidOnAccount: 0, balance: 0 }), by.get(c)!);
  for (const e of events) { const l = get(e.currency); l.due += e.organiserDue; l.paidOnEvents += e.organiserPaid; }
  for (const p of onAccount) get(p.currency).paidOnAccount += p.amount;
  for (const l of by.values()) l.balance = l.due - l.paidOnEvents - l.paidOnAccount;
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Everything the organiser report shows, also used by the organiser page (payments + refunds lists). */
export async function organiserReportData(orgId: string, mode: Mode, organiserId: string, r: Range) {
  const live = isLive(mode);
  await syncCashback(orgId, mode, { organiserId }); // statements always show current cashback
  const [o] = await db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, organiserId), eq(schema.acctOrganisers.organisationId, orgId)));
  if (!o) throw new AppError("not_found", "Organiser not found");
  const p = schema.acctOrganiserPayments;
  const [fin, payments, refunds, contracts] = await Promise.all([
    organiserFinancials(orgId, mode, organiserId, { from: r.from ?? undefined, to: r.to ?? undefined }),
    db.select({ id: p.id, date: p.paymentDate, amount: p.amount, currency: p.currency, method: p.method, reference: p.bankReference, status: p.status, notes: p.notes, voidReason: p.voidReason, eventName: schema.acctEvents.name, eventCode: schema.acctEvents.code })
      .from(p).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, p.eventId))
      .where(and(eq(p.organisationId, orgId), eq(p.organiserId, organiserId), eq(p.livemode, live), r.from ? gte(p.paymentDate, r.from) : undefined, r.to ? lte(p.paymentDate, r.to) : undefined))
      .orderBy(asc(p.paymentDate), asc(p.createdAt)),
    db.execute<{ id: string; date: Date | string; amount: string; currency: string; kind: string; event_name: string | null; event_code: string | null; order_ref: string | null; customer: string | null; status: string | null; sale_amount: string | null; sale_fee: string | null; refunded_so_far: string }>(sql`
      select r.id, r.stripe_created_at as date, (-r.amount)::text as amount, r.currency, r.kind, ev.name as event_name, ev.code as event_code,
        substring(ch.description from '^Order \\(([^)]+)\\)') as order_ref, ch.customer_name as customer, rf.status,
        s.amount::text as sale_amount, coalesce(s.commission_amount, 0)::text as sale_fee,
        (select coalesce(sum(-x.amount), 0) from stripe_balance_transactions x where x.stripe_account_ref = r.stripe_account_ref and x.charge_id = r.charge_id and x.kind in ('REFUND','DISPUTE') and x.stripe_created_at <= r.stripe_created_at)::text as refunded_so_far
      from stripe_balance_transactions r
      left join acct_events ev on ev.id = r.event_id
      left join stripe_balance_transactions s on s.stripe_account_ref = r.stripe_account_ref and s.charge_id = r.charge_id and s.kind = 'SALE'
      left join stripe_charges ch on ch.stripe_account_ref = r.stripe_account_ref and ch.charge_id = r.charge_id
      left join stripe_refunds rf on rf.stripe_account_ref = r.stripe_account_ref and rf.refund_id = r.source_id
      where r.organisation_id = ${orgId} and r.livemode = ${live} and r.kind in ('REFUND','DISPUTE') and r.organiser_id = ${organiserId}
        ${r.from ? sql` and r.stripe_created_at >= ${r.from}::date` : sql``} ${r.to ? sql` and r.stripe_created_at < (${r.to}::date + 1)` : sql``}
      order by r.stripe_created_at`),
    organiserContracts(orgId, organiserId),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  const sel = r.eventIds?.length ? new Set(r.eventIds) : null;
  const events = sel ? fin.events.filter((e) => sel.has(e.eventId)) : fin.events;
  if (sel && !events.length) throw new AppError("validation_failed", "Choose at least one event of this organiser.");
  const selCodes = new Set(events.map((e) => e.eventCode));
  const allPayments = payments.map((x) => ({ ...x, amount: Number(x.amount) }));
  // statement mode: payments tagged to the chosen events + every payment on account; other events' payments are left out
  const pay = sel ? allPayments.filter((p) => !p.eventCode || selCodes.has(p.eventCode)) : allPayments;
  const statement = sel ? statementLines(events, r.eventReport ? [] : pay.filter((p) => !p.eventCode && p.status === "PAID")) : null;
  return {
    organiser: o, totals: sel ? totalsByCurrency(events) : fin.totals, accountTotals: fin.totals, events, eventCount: sel ? events.length : fin.eventCount, contracts, statement,
    payments: pay,
    refunds: refunds.rows.filter((x) => !sel || (x.event_code && selCodes.has(x.event_code))).map((x) => {
      const ticket = n(x.sale_amount) - n(x.sale_fee), so = n(x.refunded_so_far), amt = n(x.amount);
      return { id: x.id, date: (x.date instanceof Date ? x.date.toISOString() : String(x.date)).slice(0, 10), amount: amt, currency: x.currency, kind: x.kind, eventName: x.event_name, eventCode: x.event_code,
        order: x.order_ref, customer: x.customer, status: x.status, bookingFeePart: Math.max(0, so - Math.max(ticket, so - amt)) };
    }),
  };
}

/**
 * Organiser account report (PDF): account summary per currency, settlement per event, every payment made to the organiser
 * and every refund/chargeback on their events. `internal` adds booking fees and Bilit profit; the organiser copy states
 * ticket sales net of booking fees (as on payment receipts).
 */
export async function organiserReportPdf(orgId: string, mode: Mode, organiserId: string, r: Range & { internal?: boolean }) {
  const d = await organiserReportData(orgId, mode, organiserId, r);
  const s = await getInvoiceSettings(orgId);
  const [org] = await db.select({ name: schema.organisations.name }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  const o = d.organiser, internal = !!r.internal, st = d.statement, evr = !!r.eventReport && d.events.length > 0, ev0 = d.events[0];
  const fnt = load();
  const M = 40;
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `${evr ? `Event report — ${ev0!.eventName}` : st ? "Settlement statement" : "Account report"} — ${o.name}`, Author: s.legalName ?? org?.name ?? "Bilit" } });
  doc.registerFont("reg", fnt.reg); doc.registerFont("bold", fnt.bold); doc.registerFont("fa", fnt.faReg); doc.registerFont("faBold", fnt.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, W = PW - M * 2, DARK = "#14141b", TOP = 110, BOTTOM = PH - 84;
  const seller = { name: s.legalName ?? org?.name ?? "Bilit", website: s.website ?? "bilit.events", email: s.email, address: s.address, reg: registrationLines(s) };
  const money = (v: number, c: string) => formatMoney(v, c, "en");
  const at = (t: string, x: number, y: number, op: { bold?: boolean; size?: number; color?: string; width?: number; align?: "left" | "right" | "center" } = {}) =>
    doc.font(hasRtl(t) ? (op.bold ? "faBold" : "fa") : op.bold ? "bold" : "reg").fontSize(op.size ?? 9).fillColor(op.color ?? C.text).text(rtl(t), x, y, { width: op.width, align: op.align ?? "left", lineBreak: !!op.width });
  const period = evr ? `${ev0!.eventName} (${ev0!.eventCode})` : st ? `${d.events.length} event(s)` : r.from || r.to ? `${r.from ?? "start"} – ${r.to ?? "today"}` : "all activity";
  const chrome = () => {
    doc.rect(0, 0, PW, 84).fill(DARK); doc.image(fnt.logo, M, 22, { height: 38 }); doc.rect(0, 84, PW, 4).fill(C.primary);
    at(evr ? (internal ? "EVENT REPORT (INTERNAL)" : "EVENT REPORT") : st ? (internal ? "SETTLEMENT STATEMENT (INTERNAL)" : "SETTLEMENT STATEMENT") : internal ? "ORGANISER ACCOUNT REPORT (INTERNAL)" : "ACCOUNT REPORT", M, 26, { bold: true, size: 14, color: "#ffffff", width: W, align: "right" });
    at(`${o.name} · ${period}`, M, 48, { size: 9, color: "#c7c7cc", width: W, align: "right" });
    doc.rect(0, PH - 62, PW, 62).fill(DARK); doc.rect(0, PH - 62, PW, 3).fill(C.primary);
    at([seller.name, seller.website].filter(Boolean).join(" · "), M, PH - 46, { bold: true, size: 9, color: "#ffffff", width: W, align: "center" });
    at([...seller.reg, seller.email].filter(Boolean).join(" · ") || "Issued from the Bilit finance system", M, PH - 33, { size: 8, color: "#c7c7cc", width: W, align: "center" });
  };
  const newPage = () => { doc.addPage({ size: "A4", margin: 0 }); chrome(); doc.y = TOP; };
  const ensure = (h: number) => { if (doc.y + h > BOTTOM) newPage(); };
  const heading = (t: string, sub?: string) => { ensure(60); doc.y += 8; at(t, M, doc.y, { bold: true, size: 12.5, color: C.primary }); doc.y += 18; if (sub) { at(sub, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 4; } };
  type Col = { k: string; w: number; r?: boolean };
  const table = (cols: Col[], rows: string[][], opts: { strike?: boolean[]; bold?: boolean[] } = {}) => {
    const scale = W / cols.reduce((a, c) => a + c.w, 0);
    const head = () => { const y = doc.y; doc.rect(M, y, W, 16).fill(C.tint); let x = M; for (const c of cols) { at(c.k, x + 3, y + 4, { bold: true, size: 7.5, width: c.w * scale - 6, align: c.r ? "right" : "left" }); x += c.w * scale; } doc.y = y + 18; };
    ensure(34); head();
    rows.forEach((cells, ri) => {
      const hs = cells.map((c, i) => doc.font("reg").fontSize(7.5).heightOfString(c, { width: cols[i]!.w * scale - 6 }));
      const h = Math.max(12, ...hs) + 4;
      if (doc.y + h > BOTTOM) { newPage(); head(); }
      const y = doc.y; let x = M;
      cells.forEach((c, i) => { at(c, x + 3, y + 2, { size: 7.5, bold: opts.bold?.[ri], color: opts.strike?.[ri] ? C.muted : C.text, width: cols[i]!.w * scale - 6, align: cols[i]!.r ? "right" : "left" }); x += cols[i]!.w * scale; });
      doc.y = y + h; doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.3).strokeColor(C.rule).stroke();
    });
    doc.y += 6;
  };

  chrome(); doc.y = TOP;
  // Parties
  const col = W / 2, y0 = doc.y;
  at("From", M, y0, { size: 8, color: C.muted }); at("Organiser", M + col, y0, { size: 8, color: C.muted });
  const block = (lines: Array<string | null | undefined>, x: number) => { let yy = y0 + 12; lines.filter(Boolean).forEach((l, i) => { for (const part of String(l).split("\n")) { at(part, x, yy, { size: 9, bold: i === 0, width: col - 14 }); yy += 12; } }); return yy; };
  doc.y = Math.max(block([seller.name, seller.address, ...seller.reg, seller.email], M), block([o.companyName ?? o.name, o.companyName && o.companyName !== o.name ? o.name : null, o.address, o.vatNumber && `VAT no. ${o.vatNumber}`, o.email], M + col)) + 6;
  at(`Generated ${new Date().toISOString().slice(0, 10)} · ${st ? "Events" : "Period"}: ${period}${st ? "" : ` · Events: ${d.eventCount}`}${mode === "test" ? " · TEST DATA" : ""}`, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 6;
  if (evr) {
    // Booking fee rate and who pays processing fees are internal terms: never printed on reports.
    const e = ev0!;
    at([`Event: ${e.eventName} (${e.eventCode})`, e.startsOn ? `Date: ${e.startsOn}` : null, `Status: ${e.eventStatus === "COMPLETED" ? "Finished" : e.eventStatus.toLowerCase()}`, `Orders: ${e.orders}`, o.cashbackBps ? `Cashback: ${o.cashbackBps / 100}%` : null].filter(Boolean).join(" · "), M, doc.y + 6, { size: 8.5, width: W }); doc.y += 8;
  } else if (st) { at(`Covers: ${d.events.map((e) => `${e.eventName} (${e.eventCode})`).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}`, M, doc.y + 6, { size: 8.5, width: W }); doc.y += 8; }

  // Summary per currency
  heading("Account summary", internal ? "Ticket sales include booking fees. Bilit profit is after Stripe fees and platform expenses." : "Ticket sales are stated net of booking fees. A negative balance means the amount is owed to " + seller.name + ".");
  if (!d.totals.length) { at("No activity in this period.", M, doc.y, { size: 10 }); doc.y += 16; }
  for (const f of d.totals) {
    const c = f.currency;
    const rows: Array<[string, number, boolean?]> = [
      ...(internal ? [["Gross sales (incl. booking fees)", f.grossSales], ["Booking fees", -f.bookingFees]] as Array<[string, number]> : [["Ticket sales", f.grossSales - f.bookingFees]] as Array<[string, number]>),
      ["Refunds & chargebacks", -(f.refunds + f.chargebacks)],
      ...(f.feesRecharged ? [["Payment processing fees charged", -f.feesRecharged] as [string, number]] : []),
      ...(f.deductions ? [["Other deductions", -f.deductions] as [string, number]] : []),
      ...(f.cashback ? [[`Cashback${o.cashbackBps ? ` (${o.cashbackBps / 100}%)` : ""}`, f.cashback] as [string, number]] : []),
      ...(() => {
        const l = st?.find((x) => x.currency === c);
        if (!l) return [["Amount due to organiser", f.organiserDue, true], ["Paid to organiser", -f.organiserPaid], ["Balance remaining", f.remaining, true]] as Array<[string, number, boolean?]>;
        if (evr) return [["Amount due on this event", l.due, true], ["Paid against this event", -l.paidOnEvents],
          [l.balance >= 0 ? "Balance on this event" : "Paid beyond this event's amount", Math.abs(l.balance), true]] as Array<[string, number, boolean?]>;
        return [["Amount due on these events", l.due, true], ["Paid against these events", -l.paidOnEvents], ["Payments on account (not tied to an event)", -l.paidOnAccount],
          [l.balance >= 0 ? "Balance due to organiser" : "Overpaid — balance owed to " + seller.name, Math.abs(l.balance), true]] as Array<[string, number, boolean?]>;
      })(),
      ...(internal ? [["Bilit profit (after Stripe fees & expenses)", f.bilitProfit, true] as [string, number, boolean]] : []),
    ];
    ensure(20 + rows.length * 15);
    at(c.toUpperCase(), M, doc.y, { bold: true, size: 10 }); doc.y += 14;
    for (const [k, v, b] of rows) { const y = doc.y; if (b) doc.moveTo(M, y - 2).lineTo(M + 330, y - 2).lineWidth(0.6).strokeColor(C.rule).stroke(); at(k, M, y, { size: 9.5, bold: b, width: 230 }); at(money(v, c), M + 230, y, { size: 9.5, bold: b, width: 100, align: "right" }); doc.y = y + 15; }
    if (!evr && st?.find((x) => x.currency === c)?.paidOnAccount) { at(`Payments on account are applied to the events in this statement.`, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 13; }
    if (f.cashback) { at(`Cashback = ${o.cashbackBps ? `${o.cashbackBps / 100}% of ` : ""}ticket sales after refunds, excluding booking fees, on finished events.`, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 13; }
    if (f.bookingFeesRefunded) { at(`Refunds include ${money(f.bookingFeesRefunded, c)} of booking fees returned to customers, which is charged to the organiser.`, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 13; }
    doc.y += 6;
  }


  // Settlement by event
  if (d.events.length && !evr) {
    heading("Settlement by event");
    const evCols: Col[] = [{ k: "Event", w: 140 }, { k: "Tickets", w: 46, r: true }, { k: internal ? "Gross" : "Ticket sales", w: 70, r: true }, ...(internal ? [{ k: "Booking fee", w: 62, r: true }] : []), { k: "Refunds", w: 62, r: true }, { k: "Due", w: 70, r: true }, ...(st ? [{ k: "Paid on event", w: 70, r: true }] : [{ k: "Paid", w: 70, r: true }, { k: "Remaining", w: 70, r: true }, { k: "Status", w: 58 }])];
    table(evCols, d.events.map((e) => [`${e.eventName} (${e.eventCode})${e.startsOn ? ` · ${e.startsOn}` : ""}${e.eventStatus === "CANCELLED" ? " — CANCELLED" : ""}`, String(e.tickets), money(internal ? e.grossSales : e.grossSales - e.bookingFees, e.currency), ...(internal ? [money(e.bookingFees, e.currency)] : []),
      money(e.refunds + e.chargebacks, e.currency), money(e.organiserDue, e.currency), money(e.organiserPaid, e.currency), ...(st ? [] : [money(e.remaining, e.currency), e.settlement.replace(/_/g, " ").toLowerCase()])]));
  }

  // Payments
  // An event report covers that event only: payments on account (no event) and other events' payments are left out.
  const payments = d.payments.filter((p) => p.status !== "VOIDED" && (!evr || d.events.some((e) => e.eventCode === p.eventCode)));
  heading("Payments to organiser", `${payments.length} payment(s).`);
  if (!payments.length) { at("No payments in this period.", M, doc.y, { size: 9.5 }); doc.y += 14; }
  else {
    table([{ k: "Date", w: 60 }, { k: "Event", w: 140 }, { k: "Method", w: 62 }, { k: "Reference", w: 150 }, { k: "Status", w: 40 }, { k: "Amount", w: 70, r: true }],
      payments.map((p) => [p.date, p.eventCode ? `${p.eventName} (${p.eventCode})` : st ? "On account (all events)" : "Total payable (all events)", ({ BANK_TRANSFER: "Bank transfer", STRIPE_TRANSFER: "Stripe", CASH: "Cash", OTHER: "Other" } as Record<string, string>)[p.method] ?? p.method, p.reference ?? "—", p.status === "VOIDED" ? `Voided${p.voidReason ? `: ${p.voidReason}` : ""}` : p.status.toLowerCase(), money(p.amount, p.currency)]),
    );
    const byCur = new Map<string, number>(); for (const p of payments) if (p.status === "PAID") byCur.set(p.currency, (byCur.get(p.currency) ?? 0) + p.amount);
    for (const [c, v] of byCur) { ensure(14); const y = doc.y; at(`Total paid (${c.toUpperCase()})`, M, y, { bold: true, size: 9.5, width: W - 110 }); at(money(v, c), M + W - 110, y, { bold: true, size: 9.5, width: 110, align: "right" }); doc.y = y + 14; }
  }

  // Refunds
  heading("Refunds & chargebacks", "Refunds on this organiser's events. The booking-fee part of a refund is charged to the organiser under the platform policy.");
  if (!d.refunds.length) { at("No refunds in this period.", M, doc.y, { size: 9.5 }); doc.y += 14; }
  else {
    table([{ k: "Date", w: 60 }, { k: "Event", w: 130 }, { k: "Order", w: 60 }, { k: "Customer", w: 110 }, { k: "Type", w: 55 }, { k: "Refunded", w: 70, r: true }, { k: "Of which booking fee", w: 70, r: true }],
      d.refunds.map((x) => [x.date, x.eventCode ? `${x.eventName} (${x.eventCode})` : "—", x.order ?? "—", x.customer ?? "—", x.kind === "DISPUTE" ? "Chargeback" : "Refund", money(x.amount, x.currency), x.bookingFeePart ? money(x.bookingFeePart, x.currency) : "—"]));
    const byCur = new Map<string, { a: number; f: number }>(); for (const x of d.refunds) { const g = byCur.get(x.currency) ?? { a: 0, f: 0 }; g.a += x.amount; g.f += x.bookingFeePart; byCur.set(x.currency, g); }
    for (const [c, g] of byCur) { ensure(14); const y = doc.y; at(`Total refunded (${c.toUpperCase()})${g.f ? ` · booking fee charged ${money(g.f, c)}` : ""}`, M, y, { bold: true, size: 9.5, width: W - 110 }); at(money(g.a, c), M + W - 110, y, { bold: true, size: 9.5, width: 110, align: "right" }); doc.y = y + 14; }
  }

  // Contracts
  if (d.contracts.length) {
    heading("Contracts");
    table([{ k: "Reference", w: 100 }, { k: "Contract", w: 200 }, { k: "Type", w: 80 }, { k: "Event", w: 90 }, { k: "Status", w: 70 }],
      d.contracts.map((c) => [c.reference, c.name, c.role === "MASTER" ? "Master agreement" : c.role === "EVENT_SCHEDULE" ? "Event schedule" : "Other", c.eventCode ?? "—", c.active ? "Active (signed)" : c.status.toLowerCase().replace(/_/g, " ")]));
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); at(`Page ${i + 1} of ${range.count}`, M, PH - 20, { size: 7, color: "#8e8e93", width: W, align: "center" }); }
  doc.end();
  return { bytes: await done, name: `${evr ? `event-report-${ev0!.eventCode}` : st ? "settlement-statement" : "account-report"}-${o.name.normalize("NFKD").replace(/[^\w]+/g, "-").slice(0, 40)}${internal ? "-internal" : ""}-${new Date().toISOString().slice(0, 10)}.pdf` };
}
