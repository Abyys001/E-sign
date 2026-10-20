import { and, eq, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db, schema } from "@/db";
import { formatMoney } from "@/lib/money";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import { isLive, type Mode } from "./core";
import { eventFinancials } from "./finance";
import { getInvoiceSettings, registrationLines } from "./invoices";

/**
 * Refunds statement (PDF): every refund/chargeback per event with the booking-fee part, and per event the totals the
 * organiser bears — refunded amount, booking fee kept (non-refundable policy) and Stripe fees charged.
 * For one organiser (to send to them) or for all organisers. Branded like the website (dark header and footer).
 */
export async function refundsPdf(orgId: string, mode: Mode, f: { organiserId?: string | null; from?: string | null; to?: string | null }) {
  const live = isLive(mode);
  const s = await getInvoiceSettings(orgId);
  const [org] = await db.select({ name: schema.organisations.name }).from(schema.organisations).where(eq(schema.organisations.id, orgId));
  const [organiser] = f.organiserId ? await db.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, f.organiserId), eq(schema.acctOrganisers.organisationId, orgId))) : [];
  const rows = (await db.execute<{ event_id: string; date: Date; amount: string; currency: string; order_ref: string | null; customer: string | null; status: string | null; reason: string | null; kind: string; sale_amount: string | null; sale_fee: string | null; refunded_so_far: string }>(sql`
    select r.event_id, r.stripe_created_at as date, (-r.amount)::text as amount, r.currency, r.kind,
      substring(ch.description from '^Order \\(([^)]+)\\)') as order_ref, ch.customer_name as customer, rf.status, rf.reason,
      s.amount::text as sale_amount, coalesce(s.commission_amount, 0)::text as sale_fee,
      (select coalesce(sum(-x.amount), 0) from stripe_balance_transactions x where x.stripe_account_ref = r.stripe_account_ref and x.charge_id = r.charge_id and x.kind in ('REFUND','DISPUTE') and x.stripe_created_at <= r.stripe_created_at)::text as refunded_so_far
    from stripe_balance_transactions r
    left join stripe_balance_transactions s on s.stripe_account_ref = r.stripe_account_ref and s.charge_id = r.charge_id and s.kind = 'SALE'
    left join stripe_charges ch on ch.stripe_account_ref = r.stripe_account_ref and ch.charge_id = r.charge_id
    left join stripe_refunds rf on rf.stripe_account_ref = r.stripe_account_ref and rf.refund_id = r.source_id
    where r.organisation_id = ${orgId} and r.livemode = ${live} and r.kind in ('REFUND','DISPUTE') and r.match_status = 'MATCHED' and r.event_id is not null
      ${f.organiserId ? sql` and r.organiser_id = ${f.organiserId}` : sql``}
      ${f.from ? sql` and r.stripe_created_at >= ${f.from}::date` : sql``} ${f.to ? sql` and r.stripe_created_at < (${f.to}::date + 1)` : sql``}
    order by r.stripe_created_at`)).rows;
  const n = (v: unknown) => Number(v ?? 0);
  const eventIds = [...new Set(rows.map((r) => r.event_id))];
  const figs = eventIds.length ? await eventFinancials(orgId, mode, { eventIds }) : [];

  const fnt = load();
  const M = 42;
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: "Refunds statement", Author: s.legalName ?? org?.name ?? "Bilit" } });
  doc.registerFont("reg", fnt.reg); doc.registerFont("bold", fnt.bold); doc.registerFont("fa", fnt.faReg); doc.registerFont("faBold", fnt.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, W = PW - M * 2, DARK = "#14141b", TOP = 112, BOTTOM = PH - 86;
  const seller = { name: s.legalName ?? org?.name ?? "Bilit", website: s.website ?? "bilit.events", email: s.email, reg: registrationLines(s) };
  const at = (t: string, x: number, y: number, o: { bold?: boolean; size?: number; color?: string; width?: number; align?: "left" | "right" | "center" } = {}) =>
    doc.font(hasRtl(t) ? (o.bold ? "faBold" : "fa") : o.bold ? "bold" : "reg").fontSize(o.size ?? 9).fillColor(o.color ?? C.text).text(rtl(t), x, y, { width: o.width, align: o.align ?? "left", lineBreak: !!o.width });
  const chrome = () => {
    doc.rect(0, 0, PW, 84).fill(DARK); doc.image(fnt.logo, M, 22, { height: 38 }); doc.rect(0, 84, PW, 4).fill(C.primary);
    at("REFUNDS STATEMENT", M, 28, { bold: true, size: 15, color: "#ffffff", width: W, align: "right" });
    at([organiser?.name ?? "All organisers", f.from || f.to ? `${f.from ?? "start"} – ${f.to ?? "today"}` : "all refunds"].join(" · "), M, 50, { size: 9, color: "#c7c7cc", width: W, align: "right" });
    doc.rect(0, PH - 64, PW, 64).fill(DARK); doc.rect(0, PH - 64, PW, 3).fill(C.primary);
    at([seller.name, seller.website].filter(Boolean).join(" · "), M, PH - 46, { bold: true, size: 9, color: "#ffffff", width: W, align: "center" });
    at([...seller.reg, seller.email].filter(Boolean).join(" · ") || "Issued from the Bilit finance system", M, PH - 33, { size: 8, color: "#c7c7cc", width: W, align: "center" });
  };
  const newPage = () => { doc.addPage({ size: "A4", margin: 0 }); chrome(); doc.y = TOP; };
  const ensure = (h: number) => { if (doc.y + h > BOTTOM) newPage(); };
  chrome(); doc.y = TOP;

  at(`Generated ${new Date().toISOString().slice(0, 10)}. Under the platform policy the booking fee is non-refundable: when a refund includes the booking fee, that amount is charged to the organiser and deducted from what they are paid.${mode === "test" ? " TEST DATA." : ""}`, M, doc.y, { size: 8.5, color: C.muted, width: W });
  doc.y += 10;
  if (!rows.length) { at("No refunds.", M, doc.y + 6, { size: 11 }); }

  const cols = [{ k: "Date", w: 62 }, { k: "Order", w: 62 }, { k: "Customer", w: 140 }, { k: "Type", w: 54 }, { k: "Status", w: 58 }, { k: "Refunded", w: 70, r: true }, { k: "Booking fee", w: 65, r: true }];
  const scale = W / cols.reduce((a, c) => a + c.w, 0);
  const grand = new Map<string, { refunded: number; fee: number; stripe: number }>();
  for (const evId of eventIds) {
    const evRows = rows.filter((r) => r.event_id === evId);
    const fg = figs.find((x) => x.eventId === evId);
    const cur = evRows[0]!.currency;
    ensure(80);
    at(`${fg?.eventName ?? "Event"} (${fg?.eventCode ?? ""})`, M, doc.y + 4, { bold: true, size: 11, width: W - 120 });
    if (fg?.eventStatus === "CANCELLED") at("CANCELLED", M, doc.y - 12, { bold: true, size: 9, color: "#c0262d", width: W, align: "right" });
    if (!f.organiserId && fg?.organiserName) at(fg.organiserName, M, doc.y + 1, { size: 8.5, color: C.muted });
    doc.y += 6;
    const head = doc.y; doc.rect(M, head, W, 16).fill(C.tint);
    let x = M; for (const c of cols) { at(c.k, x + 3, head + 4, { bold: true, size: 7.5, width: c.w * scale - 6, align: c.r ? "right" : "left" }); x += c.w * scale; }
    doc.y = head + 18;
    for (const r of evRows) {
      ensure(16);
      const ticket = n(r.sale_amount) - n(r.sale_fee), so = n(r.refunded_so_far), amt = n(r.amount), feePart = Math.max(0, so - Math.max(ticket, so - amt));
      const cells = [String(r.date instanceof Date ? r.date.toISOString() : r.date).slice(0, 10), r.order_ref ?? "—", r.customer ?? "—", r.kind === "DISPUTE" ? "Chargeback" : "Refund", r.status ?? "—", formatMoney(amt, cur, "en"), feePart ? formatMoney(feePart, cur, "en") : "—"];
      const y = doc.y; x = M;
      cells.forEach((c, i) => { at(c, x + 3, y + 2, { size: 8, width: cols[i]!.w * scale - 6, align: cols[i]!.r ? "right" : "left" }); x += cols[i]!.w * scale; });
      doc.y = y + 14; doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.3).strokeColor(C.rule).stroke();
    }
    const refunded = evRows.reduce((a, r) => a + n(r.amount), 0), fee = fg?.bookingFeesRefunded ?? 0, stripe = fg?.feesRecharged ?? 0;
    const g = grand.get(cur) ?? { refunded: 0, fee: 0, stripe: 0 }; g.refunded += refunded; g.fee += fee; g.stripe += stripe; grand.set(cur, g);
    ensure(56); doc.y += 4;
    const line = (k: string, v: string, b = false) => { const y = doc.y; at(k, M + W - 330, y, { size: 9, bold: b, width: 225 }); at(v, M + W - 100, y, { size: 9, bold: b, width: 100, align: "right" }); doc.y = y + 14; };
    line("Total refunded to customers", formatMoney(refunded, cur, "en"));
    line("Booking fee kept (charged to organiser)", formatMoney(fee, cur, "en"), true);
    if (stripe) line("Stripe fees charged to organiser (whole event)", formatMoney(stripe, cur, "en"));
    doc.y += 10;
  }
  if (grand.size) {
    ensure(40 + grand.size * 14);
    at("Summary", M, doc.y + 4, { bold: true, size: 12, color: C.primary }); doc.y += 22;
    for (const [cur, g] of grand) {
      at(cur.toUpperCase(), M, doc.y, { bold: true, size: 9.5 });
      at(`Refunded ${formatMoney(g.refunded, cur, "en")}  ·  Booking fee kept ${formatMoney(g.fee, cur, "en")}${g.stripe ? `  ·  Stripe fees charged ${formatMoney(g.stripe, cur, "en")}` : ""}`, M + 40, doc.y, { size: 9.5, width: W - 40 });
      doc.y += 15;
    }
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); at(`Page ${i + 1} of ${range.count}`, M, PH - 21, { size: 7, color: "#8e8e93", width: W, align: "center" }); }
  doc.end();
  return { bytes: await done, name: `refunds-${(organiser?.name ?? "all-organisers").normalize("NFKD").replace(/[^\w]+/g, "-").slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.pdf` };
}
