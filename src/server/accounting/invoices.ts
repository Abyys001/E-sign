import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { feeIncluded, formatMoney } from "@/lib/money";
import type { RequestContext } from "../audit";
import { AppError } from "../errors";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import { storage } from "../storage";
import { objectKey } from "../storage/keys";
import { acctAudit, getAcctSettings, isLive, localDate, lockKey, type Mode } from "./core";

/**
 * Customer invoices for ticket sales and credit notes for refunds, built from the Stripe transaction (what the customer
 * actually paid / got back) and the booking fee booked on it. Ticket money is shown as sold on behalf of the organiser;
 * the booking fee is Bilit's supply and carries VAT at the configured rate (prices are VAT-inclusive). Numbered per year,
 * rendered once and stored; corrections are void + reissue. A VAT invoice adds the customer's business details.
 */
type Actor = { orgId: string; userId: string; ctx: RequestContext };
const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const InvoiceSettings = z.object({
  legalName: opt(200), address: opt(1000), companyNumber: opt(60), vatNumber: opt(60), email: opt(200), website: opt(200), footer: opt(1000),
  bookingFeeVatBps: z.number().int().min(0).max(10_000).default(2000),
  ticketVatMode: z.enum(["AGENT", "INCLUDED"]).default("AGENT"), // AGENT: ticket price collected on behalf of the organiser, no Bilit VAT
  ticketVatBps: z.number().int().min(0).max(10_000).default(0),
  invoicePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).default("INV"),
  creditNotePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).default("CN"),
});
export type InvoiceSettings = z.infer<typeof InvoiceSettings>;

export async function getInvoiceSettings(orgId: string, tx: Tx | typeof db = db): Promise<InvoiceSettings> {
  await getAcctSettings(orgId, tx);
  const [s] = await tx.select({ v: schema.acctSettings.invoiceSettings }).from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  const p = InvoiceSettings.safeParse(s?.v ?? {});
  return p.success ? p.data : InvoiceSettings.parse({});
}

export async function updateInvoiceSettings(a: Actor, input: InvoiceSettings) {
  return db.transaction(async (tx) => {
    const before = await getInvoiceSettings(a.orgId, tx);
    await tx.update(schema.acctSettings).set({ invoiceSettings: input, updatedBy: a.userId, updatedAt: new Date() }).where(eq(schema.acctSettings.organisationId, a.orgId));
    await acctAudit(tx, { ...a, action: "invoice_settings.updated", entity: "settings", entityId: "invoices", old: before, new: input });
    return input;
  });
}

export const Customer = z.object({ name: z.string().trim().min(1).max(200), email: opt(200), company: opt(200), address: opt(1000), vatNumber: opt(60), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional().nullable() });
export const IssueInput = z.object({ vatInvoice: z.boolean().default(false), customer: Customer.optional() });
type Line = { description: string; quantity: number; net: number; vatRateBps: number; vat: number; gross: number; note?: string | null };

function line(description: string, quantity: number, gross: number, vatBps: number, note?: string | null): Line {
  const vat = vatBps ? feeIncluded(gross, vatBps) : 0;
  return { description, quantity, net: gross - vat, vatRateBps: vatBps, vat, gross, note: note ?? null };
}

async function nextNumber(tx: Tx, orgId: string, prefix: string, year: string) {
  await lockKey(tx, `cust-invoice:${orgId}:${prefix}:${year}`);
  const [r] = await tx.select({ n: sql<number>`coalesce(max(substring(${schema.acctCustomerInvoices.number} from '\\d+$')::int), 0)` }).from(schema.acctCustomerInvoices)
    .where(and(eq(schema.acctCustomerInvoices.organisationId, orgId), sql`${schema.acctCustomerInvoices.number} like ${`${prefix}-${year}-%`}`));
  return `${prefix}-${year}-${String((r?.n ?? 0) + 1).padStart(5, "0")}`;
}

/** Issue the invoice (for a sale) or credit note (for a refund/chargeback) of one Stripe transaction. */
export async function issueCustomerInvoice(a: Actor, btId: string, input: z.infer<typeof IssueInput>) {
  return db.transaction(async (tx) => {
    const bt = schema.stripeBalanceTransactions;
    const [row] = await tx.select().from(bt).where(and(eq(bt.id, btId), eq(bt.organisationId, a.orgId))).for("update");
    if (!row) throw new AppError("not_found", "Transaction not found");
    if (!["SALE", "REFUND", "DISPUTE"].includes(row.kind) || !row.chargeId) throw new AppError("invalid_state", "Invoices are issued for ticket sales; credit notes for refunds.");
    const credit = row.kind !== "SALE";
    const [existing] = await tx.select({ number: schema.acctCustomerInvoices.number }).from(schema.acctCustomerInvoices).where(and(eq(schema.acctCustomerInvoices.balanceTransactionRef, row.id), eq(schema.acctCustomerInvoices.status, "ISSUED")));
    if (existing) throw new AppError("conflict", `${existing.number} is already issued for this transaction. Void it first to issue a corrected one.`);
    const s = await getInvoiceSettings(a.orgId, tx);
    if (!s.legalName || !s.address) throw new AppError("invalid_state", "Fill in the company name and address under Finance settings → Invoices first.");
    if (input.vatInvoice && !s.vatNumber) throw new AppError("invalid_state", "A VAT invoice needs your VAT number under Finance settings → Invoices.");
    const [charge] = await tx.select().from(schema.stripeCharges).where(and(eq(schema.stripeCharges.stripeAccountRef, row.stripeAccountRef), eq(schema.stripeCharges.chargeId, row.chargeId)));
    const [ev] = row.eventId ? await tx.select({ e: schema.acctEvents, o: schema.acctOrganisers.name }).from(schema.acctEvents).leftJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, schema.acctEvents.organiserId)).where(eq(schema.acctEvents.id, row.eventId)) : [];
    const [sale] = credit ? await tx.select().from(bt).where(and(eq(bt.stripeAccountRef, row.stripeAccountRef), eq(bt.chargeId, row.chargeId), eq(bt.kind, "SALE"))) : [row];
    const addr = charge?.billingAddress as { line1?: string | null; line2?: string | null; city?: string | null; postalCode?: string | null; country?: string | null } | null;
    const customer = input.customer ?? { name: charge?.customerName ?? "Customer", email: charge?.customerEmail ?? null, company: null, address: addr ? [addr.line1, addr.line2, [addr.postalCode, addr.city].filter(Boolean).join(" "), addr.country].filter(Boolean).join("\n") : null, vatNumber: null, country: addr?.country ?? null };
    if (input.vatInvoice && !(customer.address && (customer.company || customer.name))) throw new AppError("validation_failed", "A VAT invoice needs the customer's (company) name and address.", [{ path: "customer.address", message: "Required" }]);

    // Amounts the customer paid (or got back), split into ticket price and booking fee as booked on the transaction.
    const gross = Math.abs(row.amount), fee = Math.min(gross, Math.abs(row.commissionAmount ?? 0));
    const qty = sale?.ticketQuantity ?? 1;
    const eventLabel = ev ? `${ev.e.name} (${ev.e.code})` : row.eventCode ?? "";
    const ticketVat = s.ticketVatMode === "INCLUDED" ? s.ticketVatBps : 0;
    const lines: Line[] = [
      line(`${credit ? "Refund — tickets" : "Tickets"}${eventLabel ? ` — ${eventLabel}` : ""}`, qty, gross - fee, ticketVat, s.ticketVatMode === "AGENT" ? `Sold by ${s.legalName} as agent on behalf of the event organiser${ev?.o ? ` ${ev.o}` : ""}.` : null),
      ...(fee > 0 ? [line(credit ? "Refund — booking fee" : "Booking fee", 1, fee, s.bookingFeeVatBps)] : []),
    ].filter((l) => l.gross > 0);
    const totals = lines.reduce((t, l) => ({ net: t.net + l.net, vat: t.vat + l.vat, gross: t.gross + l.gross }), { net: 0, vat: 0, gross: 0 });
    const { timezone } = await getAcctSettings(a.orgId, tx);
    const issueDate = localDate(new Date(), timezone);
    const number = await nextNumber(tx, a.orgId, credit ? s.creditNotePrefix : s.invoicePrefix, issueDate.slice(0, 4));
    const [related] = credit ? await tx.select({ id: schema.acctCustomerInvoices.id, number: schema.acctCustomerInvoices.number }).from(schema.acctCustomerInvoices)
      .where(and(eq(schema.acctCustomerInvoices.organisationId, a.orgId), eq(schema.acctCustomerInvoices.chargeId, row.chargeId), eq(schema.acctCustomerInvoices.kind, "INVOICE"), eq(schema.acctCustomerInvoices.status, "ISSUED"))).orderBy(desc(schema.acctCustomerInvoices.createdAt)).limit(1) : [];
    const seller = { legalName: s.legalName, address: s.address, companyNumber: s.companyNumber, vatNumber: s.vatNumber, email: s.email, website: s.website, footer: s.footer };
    const payment = { orderRef: charge?.description?.match(/^Order \(([^)]+)\)/)?.[1] ?? charge?.paymentIntentId ?? null, chargeId: row.chargeId, method: charge?.paymentMethod ?? null, paidAt: (sale ?? row).stripeCreatedAt.toISOString() };
    const [inv] = await tx.insert(schema.acctCustomerInvoices).values({
      organisationId: a.orgId, livemode: row.livemode, kind: credit ? "CREDIT_NOTE" : "INVOICE", number, vatInvoice: input.vatInvoice, balanceTransactionRef: row.id, chargeId: row.chargeId, eventId: row.eventId,
      relatedInvoiceId: related?.id ?? null, issueDate, supplyDate: localDate((sale ?? row).stripeCreatedAt, timezone), currency: row.currency, seller, customer: { ...customer, payment, relatedNumber: related?.number ?? null },
      lines, netTotal: totals.net, vatTotal: totals.vat, grossTotal: totals.gross, createdBy: a.userId,
    }).returning();
    const pdf = await renderInvoicePdf(inv!);
    const key = objectKey(a.orgId, "customer-invoice");
    const put = await storage().put(key, pdf, "application/pdf");
    const [obj] = await tx.insert(schema.storageObjects).values({ organisationId: a.orgId, key, provider: storage().name, sizeBytes: put.sizeBytes, sha256: put.sha256, contentType: "application/pdf" }).returning();
    const [done] = await tx.update(schema.acctCustomerInvoices).set({ pdfObjectId: obj!.id, pdfSha256: put.sha256 }).where(eq(schema.acctCustomerInvoices.id, inv!.id)).returning();
    await acctAudit(tx, { ...a, action: credit ? "credit_note.issued" : "customer_invoice.issued", entity: "customer_invoice", entityId: inv!.id, new: { number, vatInvoice: input.vatInvoice, gross: totals.gross, vat: totals.vat, currency: row.currency, customer: customer.name }, extra: { eventId: row.eventId, chargeId: row.chargeId } });
    return done!;
  });
}

export async function voidCustomerInvoice(a: Actor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(schema.acctCustomerInvoices).where(and(eq(schema.acctCustomerInvoices.id, id), eq(schema.acctCustomerInvoices.organisationId, a.orgId))).for("update");
    if (!inv) throw new AppError("not_found", "Invoice not found");
    if (inv.status === "VOIDED") throw new AppError("invalid_state", "Already void.");
    const [row] = await tx.update(schema.acctCustomerInvoices).set({ status: "VOIDED", voidReason: reason, voidedBy: a.userId, voidedAt: new Date(), updatedAt: new Date() }).where(eq(schema.acctCustomerInvoices.id, id)).returning();
    await acctAudit(tx, { ...a, action: "customer_invoice.voided", entity: "customer_invoice", entityId: id, old: { number: inv.number, status: inv.status }, new: { status: "VOIDED" }, reason, extra: { eventId: inv.eventId } });
    return row!;
  });
}

export async function invoicePdf(orgId: string, id: string) {
  const [r] = await db.select({ inv: schema.acctCustomerInvoices, key: schema.storageObjects.key }).from(schema.acctCustomerInvoices).innerJoin(schema.storageObjects, eq(schema.storageObjects.id, schema.acctCustomerInvoices.pdfObjectId))
    .where(and(eq(schema.acctCustomerInvoices.id, id), eq(schema.acctCustomerInvoices.organisationId, orgId)));
  if (!r) throw new AppError("not_found", "Invoice not found");
  return { bytes: await storage().getBuffer(r.key), name: `${r.inv.number}.pdf` };
}

export async function invoicesFor(orgId: string, btIds: string[]) {
  if (!btIds.length) return [];
  return db.select().from(schema.acctCustomerInvoices).where(and(eq(schema.acctCustomerInvoices.organisationId, orgId), inArray(schema.acctCustomerInvoices.balanceTransactionRef, btIds))).orderBy(desc(schema.acctCustomerInvoices.createdAt));
}

export async function listCustomerInvoices(orgId: string, mode: Mode, f: { kind?: string; q?: string; from?: string; to?: string }, page: { limit: number; offset: number }) {
  const t = schema.acctCustomerInvoices;
  const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const where = and(eq(t.organisationId, orgId), eq(t.livemode, isLive(mode)), f.kind ? eq(t.kind, f.kind) : undefined, f.from ? sql`${t.issueDate} >= ${f.from}::date` : undefined, f.to ? sql`${t.issueDate} <= ${f.to}::date` : undefined,
    f.q ? or(ilike(t.number, like(f.q)), sql`${t.customer}->>'name' ilike ${like(f.q)}`, sql`${t.customer}->>'email' ilike ${like(f.q)}`, sql`${t.customer}->>'company' ilike ${like(f.q)}`, eq(t.chargeId, f.q)) : undefined);
  const [items, total] = await Promise.all([
    db.select({ t, eventName: schema.acctEvents.name }).from(t).leftJoin(schema.acctEvents, eq(schema.acctEvents.id, t.eventId)).where(where).orderBy(desc(t.issueDate), desc(t.number)).limit(page.limit).offset(page.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(t).where(where),
  ]);
  return { items: items.map((r) => ({ ...r.t, eventName: r.eventName })), total: total[0]?.n ?? 0 };
}

// ---------- PDF ----------
type Inv = typeof schema.acctCustomerInvoices.$inferSelect;
export async function renderInvoicePdf(inv: Inv): Promise<Buffer> {
  const f = load();
  const M = 48;
  const credit = inv.kind === "CREDIT_NOTE";
  const title = credit ? "CREDIT NOTE" : inv.vatInvoice ? "VAT INVOICE" : "INVOICE";
  const seller = inv.seller as { legalName: string; address: string; companyNumber?: string | null; vatNumber?: string | null; email?: string | null; website?: string | null; footer?: string | null };
  const cust = inv.customer as { name: string; email?: string | null; company?: string | null; address?: string | null; vatNumber?: string | null; relatedNumber?: string | null; payment?: { orderRef?: string | null; chargeId?: string | null; method?: { brand?: string | null; last4?: string | null; wallet?: string | null } | null; paidAt?: string } };
  const doc = new PDFDocument({ size: "A4", margin: M, info: { Title: `${title} ${inv.number}`, Author: seller.legalName } });
  doc.registerFont("reg", f.reg); doc.registerFont("bold", f.bold); doc.registerFont("fa", f.faReg); doc.registerFont("faBold", f.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - M * 2;
  const m = (v: number) => formatMoney(v, inv.currency, "en");
  const at = (s: string, x: number, y: number, o: { bold?: boolean; size?: number; color?: string; width?: number; align?: "left" | "right" | "center" } = {}) => {
    doc.font(hasRtl(s) ? (o.bold ? "faBold" : "fa") : o.bold ? "bold" : "reg").fontSize(o.size ?? 9.5).fillColor(o.color ?? C.text).text(rtl(s), x, y, { width: o.width, align: o.align ?? "left", lineBreak: !!o.width });
  };

  // Seller (left) and document title/number (right)
  at(seller.legalName, M, M, { bold: true, size: 15 });
  let y = M + 22;
  for (const l of [seller.address, seller.companyNumber && `Company no. ${seller.companyNumber}`, seller.vatNumber && `VAT no. ${seller.vatNumber}`, [seller.email, seller.website].filter(Boolean).join(" · ")].filter(Boolean).join("\n").split("\n")) { at(l, M, y, { size: 8.5, color: C.muted }); y += 11; }
  at(title, M, M, { bold: true, size: 15, color: credit ? "#c0262d" : C.primary, width: W, align: "right" });
  const meta: Array<[string, string]> = [["Number", inv.number], ["Issue date", inv.issueDate], ...(inv.supplyDate ? [[credit ? "Refund of sale dated" : "Date of supply", inv.supplyDate] as [string, string]] : []), ...(cust.relatedNumber ? [["Credits invoice", cust.relatedNumber] as [string, string]] : [])];
  let my = M + 24;
  for (const [k, v] of meta) { at(k, M + W - 230, my, { size: 8.5, color: C.muted, width: 110 }); at(v, M + W - 115, my, { size: 8.5, bold: true, width: 115, align: "right" }); my += 13; }
  y = Math.max(y, my) + 14;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(C.rule).stroke();
  y += 14;

  // Customer + payment
  at("Bill to", M, y, { size: 8, color: C.muted });
  at("Payment", M + W / 2, y, { size: 8, color: C.muted });
  let cy = y + 12;
  for (const l of [cust.company, cust.name !== cust.company ? cust.name : null, cust.address, cust.vatNumber && `VAT no. ${cust.vatNumber}`, cust.email].filter(Boolean).join("\n").split("\n")) { at(l, M, cy, { size: 9.5, bold: cy === y + 12 }); cy += 12; }
  const pm = cust.payment?.method;
  let py = y + 12;
  for (const l of [cust.payment?.orderRef && `Order ${cust.payment.orderRef}`, pm?.brand ? `${pm.wallet ? `${pm.wallet} · ` : ""}${pm.brand.toUpperCase()} •••• ${pm.last4 ?? ""}` : "Card payment (Stripe)", cust.payment?.paidAt && `${credit ? "Refunded" : "Paid"} ${cust.payment.paidAt.slice(0, 10)}`, cust.payment?.chargeId && `Ref. ${cust.payment.chargeId}`].filter(Boolean) as string[]) { at(l, M + W / 2, py, { size: 9.5 }); py += 12; }
  y = Math.max(cy, py) + 18;

  // Lines
  const cols = [{ k: "Description", w: W - 330, a: "left" as const }, { k: "Qty", w: 40, a: "right" as const }, { k: "Net", w: 80, a: "right" as const }, { k: "VAT", w: 50, a: "right" as const }, { k: "VAT amount", w: 75, a: "right" as const }, { k: "Total", w: 85, a: "right" as const }];
  doc.rect(M, y, W, 20).fill(C.tint);
  let x = M;
  for (const c of cols) { at(c.k, x + 6, y + 6, { bold: true, size: 8.5, width: c.w - 12, align: c.a }); x += c.w; }
  y += 26;
  for (const l of inv.lines as Line[]) {
    const vals = [l.description, String(l.quantity), m(l.net), `${(l.vatRateBps / 100).toFixed(l.vatRateBps % 100 ? 2 : 0)}%`, m(l.vat), m(l.gross)];
    x = M;
    const h = doc.font("reg").fontSize(9.5).heightOfString(l.description, { width: cols[0]!.w - 12 });
    vals.forEach((v, i) => { at(v, x + 6, y, { size: 9.5, width: cols[i]!.w - 12, align: cols[i]!.a }); x += cols[i]!.w; });
    y += Math.max(14, h + 2);
    if (l.note) { at(l.note, M + 6, y, { size: 8, color: C.muted, width: cols[0]!.w + 100 }); y = doc.y + 6; }
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).strokeColor(C.rule).stroke(); y += 8;
  }
  // Totals
  const tot: Array<[string, string, boolean]> = [["Subtotal (net)", m(inv.netTotal), false], ["VAT", m(inv.vatTotal), false], [credit ? "Total refunded" : "Total paid", m(inv.grossTotal), true]];
  y += 4;
  for (const [k, v, b] of tot) { at(k, M + W - 260, y, { size: b ? 11 : 9.5, bold: b, width: 150 }); at(v, M + W - 110, y, { size: b ? 11 : 9.5, bold: b, width: 110, align: "right" }); y += b ? 18 : 14; }
  // VAT summary by rate (required on VAT invoices)
  if (inv.vatInvoice || inv.vatTotal > 0) {
    const by = new Map<number, { net: number; vat: number }>();
    for (const l of inv.lines as Line[]) { const r = by.get(l.vatRateBps) ?? { net: 0, vat: 0 }; r.net += l.net; r.vat += l.vat; by.set(l.vatRateBps, r); }
    y += 8; at("VAT summary", M, y, { bold: true, size: 9 }); y += 13;
    for (const [rate, r] of by) { at(`${(rate / 100).toFixed(rate % 100 ? 2 : 0)}%: net ${m(r.net)} · VAT ${m(r.vat)}`, M, y, { size: 8.5, color: C.muted }); y += 11; }
  }
  if (credit) { y += 8; at("This credit note reduces the amount you paid by the total above. The refund is returned to the original payment method.", M, y, { size: 8.5, color: C.muted, width: W }); }
  if (inv.status === "VOIDED") { doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }); at("VOID", 0, doc.page.height / 2 - 40, { bold: true, size: 90, color: "#f2c4c4", width: doc.page.width, align: "center" }); doc.restore(); }
  at([seller.footer, `${seller.legalName} · ${inv.number}`].filter(Boolean).join("\n"), M, doc.page.height - M - 24, { size: 7.5, color: C.muted, width: W, align: "center" });
  doc.end();
  return done;
}
