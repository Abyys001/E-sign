import { and, eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db, schema } from "@/db";
import { formatMoney } from "@/lib/money";
import { AppError } from "../errors";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import { modeOf } from "./core";
import { eventFinancials, organiserFinancials } from "./finance";
import { getInvoiceSettings } from "./invoices";

/**
 * Payment receipt (remittance advice) for a payment Bilit made to an organiser: what was paid, how, and where the
 * event's settlement stands after it (as of the payment date). Rendered on demand from the ledger, so an edited or
 * voided payment is always shown as it is now. Branded like the website: dark header band with the logo, dark footer.
 */
export async function remittancePdf(orgId: string, paymentId: string): Promise<{ bytes: Buffer; name: string }> {
  const [r] = await db.select({ p: schema.acctOrganiserPayments, o: schema.acctOrganisers, e: schema.acctEvents, org: schema.organisations.name })
    .from(schema.acctOrganiserPayments).innerJoin(schema.acctOrganisers, eq(schema.acctOrganisers.id, schema.acctOrganiserPayments.organiserId))
    .leftJoin(schema.acctEvents, eq(schema.acctEvents.id, schema.acctOrganiserPayments.eventId)).innerJoin(schema.organisations, eq(schema.organisations.id, schema.acctOrganiserPayments.organisationId))
    .where(and(eq(schema.acctOrganiserPayments.id, paymentId), eq(schema.acctOrganiserPayments.organisationId, orgId)));
  if (!r) throw new AppError("not_found", "Payment not found");
  const { p, o, e } = r;
  const mode = modeOf(p.livemode);
  const s = await getInvoiceSettings(orgId);
  // Settlement as of the payment date (this payment and earlier ones included).
  const asOf = { to: p.paymentDate };
  const fig = e ? (await eventFinancials(orgId, mode, { ...asOf, eventIds: [e.id] })).find((x) => x.currency === p.currency) ?? null
    : (await organiserFinancials(orgId, mode, o.id, asOf)).totals.find((x) => x.currency === p.currency) ?? null;
  const seller = { name: s.legalName ?? r.org ?? "Bilit", address: s.address, website: s.website ?? "bilit.events", email: s.email, vat: s.vatNumber, company: s.companyNumber };
  const number = `RA-${p.paymentDate.slice(0, 4)}-${p.id.slice(0, 8).toUpperCase()}`;

  const f = load();
  const M = 48;
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Payment receipt ${number}`, Author: seller.name, Subject: `Payment to ${o.name}` } });
  doc.registerFont("reg", f.reg); doc.registerFont("bold", f.bold); doc.registerFont("fa", f.faReg); doc.registerFont("faBold", f.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, W = PW - M * 2;
  const DARK = "#14141b";
  const m = (v: number) => formatMoney(v, p.currency, "en");
  const at = (t: string, x: number, y: number, o2: { bold?: boolean; size?: number; color?: string; width?: number; align?: "left" | "right" | "center" } = {}) =>
    doc.font(hasRtl(t) ? (o2.bold ? "faBold" : "fa") : o2.bold ? "bold" : "reg").fontSize(o2.size ?? 9.5).fillColor(o2.color ?? C.text).text(rtl(t), x, y, { width: o2.width, align: o2.align ?? "left", lineBreak: !!o2.width });

  // Header band (website style)
  doc.rect(0, 0, PW, 92).fill(DARK);
  doc.image(f.logo, M, 26, { height: 40 });
  at("PAYMENT RECEIPT", M, 30, { bold: true, size: 15, color: "#ffffff", width: W, align: "right" });
  at(number, M, 52, { size: 9, color: "#c7c7cc", width: W, align: "right" });
  doc.rect(0, 92, PW, 4).fill(C.primary);

  // Parties
  let y = 120;
  const col = W / 2;
  at("From", M, y, { size: 8, color: C.muted }); at("Paid to", M + col, y, { size: 8, color: C.muted });
  y += 12;
  const block = (lines: Array<string | null | undefined>, x: number) => { let yy = y; lines.filter(Boolean).forEach((l, i) => { for (const part of String(l).split("\n")) { at(part, x, yy, { size: 9.5, bold: i === 0, width: col - 16 }); yy += 13; } }); return yy; };
  const yL = block([seller.name, seller.address, seller.company && `Company no. ${seller.company}`, seller.vat && `VAT no. ${seller.vat}`, seller.email], M);
  const yR = block([o.companyName ?? o.name, o.companyName && o.companyName !== o.name ? o.name : null, o.address, o.vatNumber && `VAT no. ${o.vatNumber}`, o.email], M + col);
  y = Math.max(yL, yR) + 20;

  // Payment box
  const voided = p.status === "VOIDED";
  doc.roundedRect(M, y, W, 92, 8).fill(C.tint);
  at(voided ? "Payment (VOIDED)" : p.status === "PENDING" ? "Payment (scheduled)" : "Amount paid", M + 18, y + 16, { size: 9, color: C.muted });
  at(m(p.amount), M + 18, y + 30, { bold: true, size: 26, color: voided ? C.muted : C.primary });
  const kv: Array<[string, string]> = [["Payment date", p.paymentDate], ["Method", { BANK_TRANSFER: "Bank transfer", STRIPE_TRANSFER: "Stripe", CASH: "Cash", OTHER: "Other" }[p.method] ?? p.method], ["Reference", p.bankReference ?? "—"], ["Currency", p.currency.toUpperCase()]];
  kv.forEach(([k, v], i) => { const x = M + W / 2 + (i % 2) * (W / 4), yy = y + 18 + Math.floor(i / 2) * 34; at(k, x, yy, { size: 8, color: C.muted }); at(v, x, yy + 11, { size: 10, bold: true, width: W / 4 - 10 }); });
  y += 110;

  // Event / settlement
  if (e) { at("Event", M, y, { size: 8, color: C.muted }); at(`${e.name} (${e.code})${e.startsOn ? ` · ${e.startsOn}` : ""}`, M, y + 11, { bold: true, size: 11, width: W }); y += 36; }
  if (fig) {
    at(e ? `Settlement for this event as of ${p.paymentDate}` : `Your account as of ${p.paymentDate}`, M, y, { bold: true, size: 11 }); y += 20;
    const rows: Array<[string, number, boolean?]> = [
      ["Ticket sales (gross)", fig.grossSales], ["Refunds & chargebacks", -(fig.refunds + fig.chargebacks)], ["Booking fees", -fig.bookingFees],
      ...(fig.feesRecharged ? [["Payment processing fees charged", -fig.feesRecharged] as [string, number]] : []),
      ...(fig.deductions ? [["Other deductions", -fig.deductions] as [string, number]] : []),
      ["Amount due to you", fig.organiserDue, true], ["Paid to date (including this payment)", -fig.organiserPaid], ["Balance remaining", fig.remaining, true],
    ];
    for (const [k, v, b] of rows) {
      if (b) doc.moveTo(M, y - 3).lineTo(M + W, y - 3).lineWidth(b ? 0.8 : 0.3).strokeColor(C.rule).stroke();
      at(k, M, y, { size: 10, bold: b, width: W - 160 }); at(m(v), M, y, { size: 10, bold: b, width: W, align: "right" }); y += 18;
    }
    if (fig.bookingFeesRefunded > 0) { y += 4; at(`Includes ${m(fig.bookingFeesRefunded)} of booking fees refunded to customers, which are charged to the organiser under the platform's non-refundable booking-fee policy.`, M, y, { size: 8.5, color: C.muted, width: W }); y = doc.y + 6; }
    if (fig.remaining < 0) { y += 4; at(`A negative balance means ${m(-fig.remaining)} is owed to ${seller.name}.`, M, y, { size: 8.5, color: "#c0262d", width: W }); y = doc.y + 6; }
  }
  if (p.notes && !/entered on request|recorded in eur on request/i.test(p.notes)) { y += 10; at("Note", M, y, { size: 8, color: C.muted }); at(p.notes, M, y + 11, { size: 9.5, width: W }); y = doc.y + 6; }
  if (voided) { y += 10; at(`This payment was voided${p.voidReason ? `: ${p.voidReason}` : ""}. It does not count towards the balance.`, M, y, { size: 9.5, bold: true, color: "#c0262d", width: W }); }
  if (!p.livemode) { doc.save().rotate(-30, { origin: [PW / 2, PH / 2] }); at("TEST", 0, PH / 2 - 40, { bold: true, size: 90, color: "#e5e5ea", width: PW, align: "center" }); doc.restore(); }

  // Footer band (website style)
  doc.rect(0, PH - 70, PW, 70).fill(DARK);
  doc.rect(0, PH - 70, PW, 3).fill(C.primary);
  at([seller.name, seller.website].filter(Boolean).join(" · "), M, PH - 52, { bold: true, size: 9, color: "#ffffff", width: W, align: "center" });
  at([seller.email, seller.vat && `VAT ${seller.vat}`, seller.company && `Company ${seller.company}`].filter(Boolean).join(" · ") || "Payment receipt issued from the Bilit finance system", M, PH - 38, { size: 8, color: "#c7c7cc", width: W, align: "center" });
  at(`Remittance advice ${number} · generated ${new Date().toISOString().slice(0, 10)}`, M, PH - 25, { size: 7, color: "#8e8e93", width: W, align: "center" });
  doc.end();
  return { bytes: await done, name: `${number}-${o.name.normalize("NFKD").replace(/[^\w]+/g, "-").slice(0, 40)}.pdf` };
}
