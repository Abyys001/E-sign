import { and, asc, desc, eq, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatMoney } from "@/lib/money";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { log } from "../logger";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import { acctAudit, accountingEnabled, Currency, getAcctSettings, IsoDate, isLive, isPeriodClosed, localDate, ModeSchema, type Mode } from "./core";
import { eventFinancials } from "./finance";
import { getInvoiceSettings, registrationLines } from "./invoices";
import { postEntry, reverseEntry } from "./ledger";

/**
 * Profit share: a partner (e.g. the web developer) earns a % of each event's Bilit profit. The share is an expense of
 * Bilit (6950 Profit Share) owed to the partner (2400 Profit Share Payable). It is kept true automatically: for every
 * event × currency the target share = % × profit BEFORE profit shares (0 when the event made a loss, unless the partner
 * shares losses); the difference to what is already booked is posted as an adjustment, so new sales and refunds flow
 * through. Payments to the partner reduce what is owed. Everything is append-only like the rest of the ledger.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };

export const PartnerInput = z.object({
  name: z.string().trim().min(1).max(200), role: z.string().trim().max(120).optional().nullable(), email: z.string().trim().email().max(200).optional().nullable().or(z.literal("").transform(() => null)),
  sharePercent: z.number().min(0).max(100), appliesFrom: IsoDate.optional().nullable(), lossesCount: z.boolean().default(false), active: z.boolean().default(true), notes: z.string().trim().max(2000).optional().nullable(),
});
export const PartnerPaymentInput = z.object({
  mode: ModeSchema, partnerId: z.string().uuid(), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: Currency, paymentDate: IsoDate,
  method: z.enum(["BANK_TRANSFER", "STRIPE_TRANSFER", "CASH", "OTHER"]).default("BANK_TRANSFER"), bankReference: z.string().trim().max(120).optional().nullable(), notes: z.string().trim().max(2000).optional().nullable(),
});

async function partner(orgId: string, id: string) {
  const [p] = await db.select().from(schema.acctProfitPartners).where(and(eq(schema.acctProfitPartners.id, id), eq(schema.acctProfitPartners.organisationId, orgId)));
  if (!p) throw new AppError("not_found", "Partner not found");
  return p;
}

export async function listPartners(orgId: string) {
  return db.select().from(schema.acctProfitPartners).where(eq(schema.acctProfitPartners.organisationId, orgId)).orderBy(asc(schema.acctProfitPartners.name));
}

export async function savePartner(a: Actor, id: string | null, input: z.infer<typeof PartnerInput>) {
  const values = { name: input.name, role: input.role ?? null, email: input.email ?? null, shareBps: Math.round(input.sharePercent * 100), appliesFrom: input.appliesFrom ?? null, lossesCount: input.lossesCount, active: input.active, notes: input.notes ?? null };
  return db.transaction(async (tx) => {
    let row;
    if (id) {
      const old = await partner(a.orgId, id);
      [row] = await tx.update(schema.acctProfitPartners).set({ ...values, updatedAt: new Date() }).where(eq(schema.acctProfitPartners.id, id)).returning();
      await acctAudit(tx, { ...a, action: "profit_partner.updated", entity: "profit_partner", entityId: id, old: { shareBps: old.shareBps, appliesFrom: old.appliesFrom, lossesCount: old.lossesCount, active: old.active }, new: values });
    } else {
      [row] = await tx.insert(schema.acctProfitPartners).values({ organisationId: a.orgId, createdBy: a.userId, ...values }).returning();
      await acctAudit(tx, { ...a, action: "profit_partner.created", entity: "profit_partner", entityId: row!.id, new: values });
    }
    return row!;
  });
}

// ---------- accrual (true-up) ----------
type Booked = Map<string, number>; // `${eventId}|${currency}` → booked share (minor units)
async function bookedShares(orgId: string, live: boolean, partnerId: string): Promise<Booked> {
  const r = await db.execute<{ event_id: string; currency: string; amt: string }>(sql`
    select l.event_id::text, e.currency, sum(l.debit - l.credit)::text as amt
    from acct_journal_lines l join acct_journal_entries e on e.id = l.entry_id join acct_accounts a on a.id = l.account_id
    where e.organisation_id = ${orgId} and e.livemode = ${live} and a.system_key = 'profit_share' and e.source_type = 'profit_share' and e.source_id = ${partnerId} and l.event_id is not null
    group by 1, 2`);
  return new Map(r.rows.map((x) => [`${x.event_id}|${x.currency}`, Number(x.amt)]));
}

/** What the partner is entitled to for each event right now, and what is already booked. */
async function shareRows(orgId: string, mode: Mode, p: typeof schema.acctProfitPartners.$inferSelect) {
  const [events, booked] = await Promise.all([eventFinancials(orgId, mode), bookedShares(orgId, isLive(mode), p.id)]);
  return events.map((e) => {
    const before = e.bilitProfit + e.profitShare; // profit before any profit shares — the share never reduces its own base
    const inScope = p.active && (!p.appliesFrom || (e.startsOn ?? "9999-12-31") >= p.appliesFrom);
    const base = p.lossesCount ? before : Math.max(0, before);
    const target = inScope ? Math.round((base * p.shareBps) / 10_000) : 0;
    const k = `${e.eventId}|${e.currency}`;
    return { e, before, target, booked: booked.get(k) ?? 0, inScope };
  });
}

/** Post the difference between the target share and what is booked, per event × currency. Idempotent. */
export async function syncProfitShares(orgId: string, mode: Mode, opts: { userId?: string | null } = {}) {
  const partners = await listPartners(orgId);
  const { timezone } = await getAcctSettings(orgId);
  const today = localDate(new Date(), timezone || "UTC");
  let posted = 0;
  for (const p of partners) {
    if (!p.active) continue; // deactivating stops further adjustments; earned shares stay owed
    for (const r of await shareRows(orgId, mode, p)) {
      const diff = r.target - r.booked;
      if (!diff) continue;
      // Recognise the cost in the month of the event (if that period is open), else today.
      let date = r.e.startsOn && r.e.startsOn <= today ? r.e.startsOn : today;
      if (await isPeriodClosed(db, orgId, date)) date = today;
      try {
        await db.transaction(async (tx) => {
          const { created } = await postEntry(tx, {
            orgId, livemode: isLive(mode), entryType: "PROFIT_SHARE", sourceDate: new Date(`${date}T12:00:00Z`), entryDate: date, currency: r.e.currency,
            description: `${p.name} ${p.shareBps / 100}% profit share — ${r.e.eventName} (${r.e.eventCode})${r.booked ? ` adjustment (profit now ${formatMoney(r.before, r.e.currency, "en")})` : ""}`,
            eventId: r.e.eventId, organiserId: r.e.organiserId, sourceType: "profit_share", sourceId: p.id, idempotencyKey: `pshare:${p.id}:${r.e.eventId}:${r.e.currency}:${r.booked}->${r.target}`, createdBy: opts.userId ?? null, timezone,
            postings: [{ account: "profit_share", amount: diff, eventId: r.e.eventId, memo: `${p.name} share` }, { account: "profit_share_payable", amount: -diff, eventId: r.e.eventId, memo: p.name }],
          });
          if (created) { posted++; await acctAudit(tx, { orgId, userId: opts.userId ?? null, action: "profit_share.accrued", entity: "profit_partner", entityId: p.id, new: { eventId: r.e.eventId, currency: r.e.currency, from: r.booked, to: r.target, profitBefore: r.before } }); }
        });
      } catch (e) { log.warn("accounting.profit_share_post_failed", { partner: p.id, event: r.e.eventId, error: String(e).slice(0, 300) }); }
    }
  }
  return { posted };
}

/** Worker: keep shares current for every organisation that has partners. */
export async function syncAllProfitShares() {
  if (!accountingEnabled()) return 0;
  const orgs = await db.selectDistinct({ orgId: schema.acctProfitPartners.organisationId }).from(schema.acctProfitPartners).where(eq(schema.acctProfitPartners.active, true));
  for (const o of orgs) for (const mode of ["live", "test"] as const) { try { await syncProfitShares(o.orgId, mode); } catch (e) { log.warn("accounting.profit_share_sync_failed", { orgId: o.orgId, error: String(e).slice(0, 300) }); } }
  return orgs.length;
}

// ---------- overview ----------
export async function partnerOverview(orgId: string, mode: Mode, partnerId: string) {
  const p = await partner(orgId, partnerId);
  await syncProfitShares(orgId, mode);
  const rows = (await shareRows(orgId, mode, p)).filter((r) => r.booked || r.target || r.e.grossSales);
  const pays = await db.select().from(schema.acctPartnerPayments).where(and(eq(schema.acctPartnerPayments.organisationId, orgId), eq(schema.acctPartnerPayments.partnerId, p.id), eq(schema.acctPartnerPayments.livemode, isLive(mode)))).orderBy(desc(schema.acctPartnerPayments.paymentDate), desc(schema.acctPartnerPayments.createdAt));
  const totals = new Map<string, { currency: string; profit: number; earned: number; paid: number; owed: number; events: number }>();
  const t = (c: string) => { let x = totals.get(c); if (!x) { x = { currency: c, profit: 0, earned: 0, paid: 0, owed: 0, events: 0 }; totals.set(c, x); } return x; };
  const monthly = new Map<string, { month: string; currency: string; profit: number; share: number; events: number }>();
  for (const r of rows) {
    const x = t(r.e.currency); x.profit += r.before; x.earned += r.booked; x.events++;
    const month = (r.e.startsOn ?? "").slice(0, 7) || "no date";
    const k = `${month}|${r.e.currency}`; const mm = monthly.get(k) ?? { month, currency: r.e.currency, profit: 0, share: 0, events: 0 };
    mm.profit += r.before; mm.share += r.booked; mm.events++; monthly.set(k, mm);
  }
  for (const py of pays) if (py.status === "PAID") t(py.currency).paid += py.amount;
  for (const x of totals.values()) x.owed = x.earned - x.paid;
  return {
    partner: { ...p, sharePercent: p.shareBps / 100 },
    totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    events: rows.map((r) => ({ eventId: r.e.eventId, code: r.e.eventCode, name: r.e.eventName, date: r.e.startsOn, status: r.e.eventStatus, organiser: r.e.organiserName, currency: r.e.currency, grossSales: r.e.grossSales, bookingFees: r.e.bookingFees, profitBefore: r.before, share: r.booked, inScope: r.inScope, loss: r.before < 0 }))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name)),
    monthly: [...monthly.values()].sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency)),
    payments: pays,
  };
}

// ---------- payments ----------
export async function recordPartnerPayment(a: Actor, input: z.infer<typeof PartnerPaymentInput>) {
  const p = await partner(a.orgId, input.partnerId);
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const { mode, ...rest } = input;
    const [row] = await tx.insert(schema.acctPartnerPayments).values({ organisationId: a.orgId, livemode: isLive(mode), ...rest, bankReference: rest.bankReference ?? null, notes: rest.notes ?? null, createdBy: a.userId }).returning();
    const { entry } = await postEntry(tx, {
      orgId: a.orgId, livemode: row!.livemode, entryType: "PARTNER_PAYMENT", sourceDate: new Date(`${row!.paymentDate}T12:00:00Z`), entryDate: row!.paymentDate, currency: row!.currency,
      description: `Profit share paid to ${p.name}${row!.bankReference ? ` — ${row!.bankReference}` : ""}`, reference: row!.bankReference, sourceType: "partner_payment", sourceId: row!.id, idempotencyKey: `ppay:${row!.id}`, createdBy: a.userId, timezone,
      postings: [{ account: "profit_share_payable", amount: row!.amount, memo: `Paid to ${p.name}` }, { account: "bank", amount: -row!.amount, memo: row!.method }],
    });
    const [done] = await tx.update(schema.acctPartnerPayments).set({ journalEntryId: entry.id }).where(eq(schema.acctPartnerPayments.id, row!.id)).returning();
    await acctAudit(tx, { ...a, action: "partner_payment.recorded", entity: "partner_payment", entityId: row!.id, new: { ...rest, mode, partner: p.name } });
    return done!;
  });
}

export async function voidPartnerPayment(a: Actor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const [p] = await tx.select().from(schema.acctPartnerPayments).where(and(eq(schema.acctPartnerPayments.id, id), eq(schema.acctPartnerPayments.organisationId, a.orgId))).for("update");
    if (!p) throw new AppError("not_found", "Payment not found");
    if (p.status === "VOIDED") throw new AppError("invalid_state", "Already voided.");
    const rev = p.journalEntryId ? await reverseEntry(tx, { orgId: a.orgId, entryId: p.journalEntryId, reason, userId: a.userId, timezone }) : null;
    const [row] = await tx.update(schema.acctPartnerPayments).set({ status: "VOIDED", voidEntryId: rev?.id ?? null, voidReason: reason, voidedBy: a.userId, voidedAt: new Date() }).where(eq(schema.acctPartnerPayments.id, id)).returning();
    await tx.execute(sql`update acct_wise_transactions set partner_payment_id = null, updated_at = now() where partner_payment_id = ${id}`);
    await acctAudit(tx, { ...a, action: "partner_payment.voided", entity: "partner_payment", entityId: id, reason, extra: { amount: p.amount, currency: p.currency } });
    return row!;
  });
}

// ---------- statement PDF ----------
export async function partnerStatementPdf(orgId: string, mode: Mode, partnerId: string) {
  const d = await partnerOverview(orgId, mode, partnerId);
  const s = await getInvoiceSettings(orgId);
  const [org] = await db.select({ name: schema.organisations.name }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  const fnt = load(), M = 40;
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `Profit share statement — ${d.partner.name}`, Author: s.legalName ?? org?.name ?? "Bilit" } });
  doc.registerFont("reg", fnt.reg); doc.registerFont("bold", fnt.bold); doc.registerFont("fa", fnt.faReg); doc.registerFont("faBold", fnt.faBold);
  const chunks: Buffer[] = []; doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, W = PW - M * 2, DARK = "#14141b", TOP = 110, BOTTOM = PH - 84;
  const seller = { name: s.legalName ?? org?.name ?? "Bilit", website: s.website ?? "bilit.events", email: s.email, address: s.address, reg: registrationLines(s) };
  const money = (v: number, c: string) => formatMoney(v, c, "en");
  const at = (t: string, x: number, y: number, op: { bold?: boolean; size?: number; color?: string; width?: number; align?: "left" | "right" | "center" } = {}) =>
    doc.font(hasRtl(t) ? (op.bold ? "faBold" : "fa") : op.bold ? "bold" : "reg").fontSize(op.size ?? 9).fillColor(op.color ?? C.text).text(rtl(t), x, y, { width: op.width, align: op.align ?? "left", lineBreak: !!op.width });
  const chrome = () => {
    doc.rect(0, 0, PW, 84).fill(DARK); doc.image(fnt.logo, M, 22, { height: 38 }); doc.rect(0, 84, PW, 4).fill(C.primary);
    at("PROFIT SHARE STATEMENT", M, 26, { bold: true, size: 14, color: "#ffffff", width: W, align: "right" });
    at(`${d.partner.name} · ${d.partner.sharePercent}% of event profit`, M, 48, { size: 9, color: "#c7c7cc", width: W, align: "right" });
    doc.rect(0, PH - 62, PW, 62).fill(DARK); doc.rect(0, PH - 62, PW, 3).fill(C.primary);
    at([seller.name, seller.website].filter(Boolean).join(" · "), M, PH - 46, { bold: true, size: 9, color: "#ffffff", width: W, align: "center" });
    at([...seller.reg, seller.email].filter(Boolean).join(" · ") || "Issued from the Bilit finance system", M, PH - 33, { size: 8, color: "#c7c7cc", width: W, align: "center" });
  };
  const newPage = () => { doc.addPage({ size: "A4", margin: 0 }); chrome(); doc.y = TOP; };
  const ensure = (h: number) => { if (doc.y + h > BOTTOM) newPage(); };
  const heading = (t: string, sub?: string) => { ensure(60); doc.y += 8; at(t, M, doc.y, { bold: true, size: 12.5, color: C.primary }); doc.y += 18; if (sub) { at(sub, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 4; } };
  type Col = { k: string; w: number; r?: boolean };
  const table = (cols: Col[], rows: string[][]) => {
    const scale = W / cols.reduce((a, c) => a + c.w, 0);
    const head = () => { const y = doc.y; doc.rect(M, y, W, 16).fill(C.tint); let x = M; for (const c of cols) { at(c.k, x + 3, y + 4, { bold: true, size: 7.5, width: c.w * scale - 6, align: c.r ? "right" : "left" }); x += c.w * scale; } doc.y = y + 18; };
    ensure(34); head();
    for (const cells of rows) {
      const h = Math.max(12, ...cells.map((c, i) => doc.font("reg").fontSize(7.5).heightOfString(c, { width: cols[i]!.w * scale - 6 }))) + 4;
      if (doc.y + h > BOTTOM) { newPage(); head(); }
      const y = doc.y; let x = M;
      cells.forEach((c, i) => { at(c, x + 3, y + 2, { size: 7.5, width: cols[i]!.w * scale - 6, align: cols[i]!.r ? "right" : "left" }); x += cols[i]!.w * scale; });
      doc.y = y + h; doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.3).strokeColor(C.rule).stroke();
    }
    doc.y += 6;
  };
  chrome(); doc.y = TOP;
  at(`Generated ${new Date().toISOString().slice(0, 10)}${mode === "test" ? " · TEST DATA" : ""} · ${d.partner.lossesCount ? "Losses are shared" : "Events with a loss give a 0 share"}${d.partner.appliesFrom ? ` · Events from ${d.partner.appliesFrom}` : ""}`, M, doc.y, { size: 8.5, color: C.muted, width: W }); doc.y += 8;
  heading("Summary", "Profit = Bilit's profit on the event (booking fees and other income less Stripe fees and Bilit's event costs), before profit shares.");
  for (const x of d.totals) {
    ensure(80); at(x.currency.toUpperCase(), M, doc.y, { bold: true, size: 10 }); doc.y += 14;
    for (const [k, v, b] of [["Event profit (before share)", x.profit], [`Share earned (${d.partner.sharePercent}%)`, x.earned, true], ["Paid", -x.paid], ["Balance owed", x.owed, true]] as Array<[string, number, boolean?]>) {
      const y = doc.y; at(k, M, y, { size: 9.5, bold: b, width: 230 }); at(money(v, x.currency), M + 230, y, { size: 9.5, bold: b, width: 100, align: "right" }); doc.y = y + 15;
    }
    doc.y += 6;
  }
  heading("By month", "Month of the event.");
  table([{ k: "Month", w: 70 }, { k: "Currency", w: 50 }, { k: "Events", w: 50, r: true }, { k: "Profit", w: 90, r: true }, { k: "Share", w: 90, r: true }], d.monthly.map((m) => [m.month, m.currency.toUpperCase(), String(m.events), money(m.profit, m.currency), money(m.share, m.currency)]));
  heading("By event");
  table([{ k: "Event", w: 190 }, { k: "Date", w: 60 }, { k: "Profit", w: 80, r: true }, { k: "Share", w: 80, r: true }], d.events.map((e) => [`${e.name} (${e.code})${e.status === "CANCELLED" ? " — cancelled" : ""}`, e.date ?? "—", money(e.profitBefore, e.currency), e.loss && !d.partner.lossesCount ? `${money(0, e.currency)} (loss)` : money(e.share, e.currency)]));
  const paid = d.payments.filter((p) => p.status === "PAID");
  heading("Payments", `${paid.length} payment(s).`);
  if (paid.length) table([{ k: "Date", w: 70 }, { k: "Reference", w: 200 }, { k: "Method", w: 80 }, { k: "Amount", w: 90, r: true }], paid.map((p) => [p.paymentDate, p.bankReference ?? "—", p.method.replace("_", " ").toLowerCase(), money(p.amount, p.currency)]));
  else { at("No payments yet.", M, doc.y, { size: 9.5 }); doc.y += 14; }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); at(`Page ${i + 1} of ${range.count}`, M, PH - 20, { size: 7, color: "#8e8e93", width: W, align: "center" }); }
  doc.end();
  return { bytes: await done, name: `profit-share-${d.partner.name.normalize("NFKD").replace(/[^\w]+/g, "-").slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.pdf` };
}
