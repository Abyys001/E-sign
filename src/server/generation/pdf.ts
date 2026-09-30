import PDFDocument from "pdfkit";
import { C, hasRtl, load, rtl } from "../signing/certificate";
import type { ComposedSection } from "../clauses/compose";

export type SignatureAnchor = { party: "bilit" | "organiser"; kind: "signature" | "date"; page: number; x: number; y: number; width: number; height: number };
export type RenderedAgreement = { bytes: Buffer; pageCount: number; anchors: SignatureAnchor[] };

export type RenderInput = {
  title: string;
  reference: string;
  organisationName: string;
  organiserName: string;
  effectiveDate: string;
  sections: ComposedSection[];
  footerNote: string;
};

const M = 56;

/** Render the composed agreement to a PDF and report where the signature blocks sit (page fractions, top-left origin). */
export async function renderAgreementPdf(d: RenderInput): Promise<RenderedAgreement> {
  const f = load();
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: d.title, Author: "Bilit.event E-Sign", Subject: d.reference } });
  doc.registerFont("reg", f.reg); doc.registerFont("bold", f.bold); doc.registerFont("fa", f.faReg); doc.registerFont("faBold", f.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - M * 2;
  const H = doc.page.height;

  const text = (s: string, o: { bold?: boolean; size?: number; color?: string; align?: "left" | "center" | "right"; gap?: number } = {}) => {
    doc.font(hasRtl(s) ? (o.bold ? "faBold" : "fa") : o.bold ? "bold" : "reg").fontSize(o.size ?? 10).fillColor(o.color ?? C.text);
    doc.text(rtl(s), M, doc.y, { width: W, align: o.align ?? "left", lineGap: 2 });
    if (o.gap) doc.moveDown(o.gap);
  };
  const ensure = (h: number) => { if (doc.y + h > H - M - 20) doc.addPage(); };

  doc.image(f.logo, M, M - 8, { height: 26 });
  doc.y = M + 34;
  text(d.title, { bold: true, size: 17, gap: 0.4 });
  text(`Reference ${d.reference}  ·  Effective ${d.effectiveDate}`, { size: 9, color: C.muted, gap: 0.3 });
  text(`${d.organisationName} and ${d.organiserName}`, { size: 9, color: C.muted, gap: 1 });

  for (const s of d.sections) {
    ensure(70);
    text(`${s.number}. ${s.category}`, { bold: true, size: 11, color: C.primary, gap: 0.3 });
    for (const cl of s.clauses) {
      ensure(60);
      text(`${cl.number}  ${cl.title}`, { bold: true, size: 10, gap: 0.15 });
      for (const para of cl.body.split("\n")) { if (para.trim()) { ensure(28); text(para, { size: 9.5, gap: 0.25 }); } }
      doc.moveDown(0.4);
    }
  }

  // Signature page: fixed geometry so fields can be placed exactly on the boxes.
  doc.addPage();
  const sigPage = doc.bufferedPageRange().count - 1;
  doc.y = M;
  text("Signatures", { bold: true, size: 14, gap: 0.6 });
  text("Executed by the parties by electronic signature on the dates shown.", { size: 9.5, color: C.muted });
  const blockY = [150, 360];
  const anchors: SignatureAnchor[] = [];
  const parties: Array<{ party: "bilit" | "organiser"; name: string }> = [{ party: "bilit", name: d.organisationName }, { party: "organiser", name: d.organiserName }];
  parties.forEach((p, i) => {
    const y = blockY[i]!;
    doc.font("bold").fontSize(10).fillColor(C.text).text(`Signed for and on behalf of ${p.name}`, M, y, { width: W });
    const box = { x: M, y: y + 28, w: 260, h: 60 };
    doc.rect(box.x, box.y, box.w, box.h).lineWidth(0.6).strokeColor(C.rule).stroke();
    doc.font("reg").fontSize(8).fillColor(C.muted).text("Signature", box.x, box.y + box.h + 3);
    const dbox = { x: M + 290, y: y + 28, w: 150, h: 30 };
    doc.rect(dbox.x, dbox.y, dbox.w, dbox.h).lineWidth(0.6).strokeColor(C.rule).stroke();
    doc.font("reg").fontSize(8).fillColor(C.muted).text("Date", dbox.x, dbox.y + dbox.h + 3);
    const pw = doc.page.width, ph = doc.page.height;
    anchors.push({ party: p.party, kind: "signature", page: sigPage, x: box.x / pw, y: box.y / ph, width: box.w / pw, height: box.h / ph });
    anchors.push({ party: p.party, kind: "date", page: sigPage, x: dbox.x / pw, y: dbox.y / ph, width: dbox.w / pw, height: dbox.h / ph });
  });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // footer sits in the bottom margin; without this pdfkit would add a blank page
    doc.font("reg").fontSize(7.5).fillColor(C.muted);
    doc.text(`${d.reference}  ·  Page ${i + 1} of ${range.count}`, M, H - M + 6, { width: W, align: "left", lineBreak: false });
    doc.text(d.footerNote, M, H - M + 6, { width: W, align: "right", lineBreak: false });
  }
  doc.end();
  return { bytes: await done, pageCount: range.count, anchors };
}
