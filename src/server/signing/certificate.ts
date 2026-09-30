import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const A = (p: string) => path.join(process.cwd(), "assets", p);
let fonts: { reg: Buffer; bold: Buffer; faReg: Buffer; faBold: Buffer; logo: Buffer } | undefined;
export const load = () => (fonts ??= { reg: readFileSync(A("fonts/GoogleSansFlex-Regular.ttf")), bold: readFileSync(A("fonts/GoogleSansFlex-Bold.ttf")), faReg: readFileSync(A("fonts/Vazirmatn-Regular.ttf")), faBold: readFileSync(A("fonts/Vazirmatn-Bold.ttf")), logo: readFileSync(A("logo.png")) });

// Project palette (see src/app/globals.css): --color-4 text, --color-7 muted, --color-2 rule, --color-1 tint, --color-5 primary.
export const C = { text: "#0d0d12", muted: "#6e6e73", rule: "#98989d", tint: "#f5f5f7", primary: "#20ac6a", white: "#ffffff" };

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/** pdfkit shapes Arabic-script glyphs but does not run the bidi algorithm; flip pure-RTL strings so they read correctly. */
export const rtl = (s: string) => (RTL.test(s) && !/[A-Za-z]/.test(s) ? [...s].reverse().join("") : s);
export const hasRtl = (s: string) => RTL.test(s);

export type CertificateData = {
  brand: { orgName: string; supportEmail: string };
  contract: { id: string; reference: string; name: string; pages: number; sentAt: Date | null; completedAt: Date };
  certificateId: string;
  verificationUrl: string;
  sourceHash: string;
  finalHash: string;
  auditHead: string | null;
  timezone: string;
  includeIp: boolean;
  signers: Array<{ name: string; email: string; role: string; company: string | null; authMethod: string; status: string; signedAt: Date | null; ip: string | null; device: string; methods: string[]; viewedAt: Date | null; declineReason: string | null }>;
  events: Array<{ at: Date; type: string; actor: string }>;
};

const EVENT_LABEL: Record<string, string> = {
  "contract.created": "Contract created", "contract.sent": "Contract sent for signature", "document.viewed": "Document viewed", "consent.given": "Electronic-signature consent recorded",
  "signature.applied": "Signature applied", "recipient.completed": "Recipient completed signing", "signing.locked": "Signing workflow locked", "document.final_generated": "Final signed PDF generated",
  "otp.verified": "One-time code verified", "passcode.verified": "Passcode verified", "contract.declined": "Recipient declined", "document.version_created": "Document version stored",
};

export async function buildCertificate(d: CertificateData): Promise<Buffer> {
  const f = load();
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Certificate of Completion ${d.certificateId}`, Author: "Bilit.event E-Sign", Subject: d.contract.reference, Keywords: `certificate:${d.certificateId}` }, bufferPages: true });
  doc.registerFont("reg", f.reg); doc.registerFont("bold", f.bold); doc.registerFont("fa", f.faReg); doc.registerFont("faBold", f.faBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 96;
  const fmt = (x: Date | null) => (x ? `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: d.timezone }).format(x)}` : "—");
  const utc = (x: Date | null) => (x ? x.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—");
  const text = (s: string, o: { bold?: boolean; size?: number; color?: string; x?: number; y?: number; width?: number; align?: "left" | "right" | "center" } = {}) => {
    const font = hasRtl(s) ? (o.bold ? "faBold" : "fa") : o.bold ? "bold" : "reg";
    doc.font(font).fontSize(o.size ?? 9.5).fillColor(o.color ?? C.text);
    const opts = { width: o.width ?? W, align: o.align ?? "left" } as const;
    doc.text(rtl(s), o.x ?? 48, o.y ?? doc.y, opts);
  };
  const ensure = (h: number) => { if (doc.y + h > doc.page.height - 70) doc.addPage(); };

  // Header
  doc.image(f.logo, 48, 44, { height: 30 });
  text("CERTIFICATE OF COMPLETION", { bold: true, size: 9, color: C.muted, x: 48, y: 52, width: W, align: "right" });
  doc.moveTo(48, 90).lineTo(48 + W, 90).lineWidth(2).strokeColor(C.primary).stroke();
  doc.y = 106;
  text(d.contract.name, { bold: true, size: 20 });
  doc.moveDown(0.2);
  text(`${d.brand.orgName} · ${d.contract.reference}`, { size: 10.5, color: C.muted });
  doc.moveDown(1);

  // Summary block
  const top = doc.y;
  const qr = await QRCode.toBuffer(d.verificationUrl, { margin: 1, width: 240, color: { dark: C.text, light: C.white } });
  doc.roundedRect(48, top, W, 118, 6).fillColor(C.tint).fill();
  const row = (k: string, v: string, y: number, mono = false) => {
    text(k, { size: 8, color: C.muted, x: 62, y, width: 110 });
    doc.font(mono ? "reg" : "reg").fontSize(mono ? 7.5 : 9).fillColor(C.text).text(hasRtl(v) ? rtl(v) : v, 176, y - (mono ? 0.5 : 0), { width: W - 190 - 96 });
  };
  row("Certificate ID", d.certificateId, top + 12);
  row("Contract ID", d.contract.id, top + 30, true);
  row("Completed", `${fmt(d.contract.completedAt)}  (${utc(d.contract.completedAt)})`, top + 48);
  row("Pages", String(d.contract.pages), top + 66);
  row("Sent", fmt(d.contract.sentAt), top + 84);
  row("Signers", String(d.signers.filter((s) => s.role !== "CC").length), top + 102);
  doc.image(qr, 48 + W - 104, top + 9, { width: 96 });
  doc.y = top + 132;

  // Integrity
  text("Document integrity", { bold: true, size: 12 });
  doc.moveDown(0.4);
  const hashRow = (label: string, hash: string) => { text(label, { size: 8, color: C.muted }); doc.font("reg").fontSize(7.8).fillColor(C.text).text(hash, 48, doc.y, { width: W }); doc.moveDown(0.5); };
  hashRow("SHA-256 of the document as sent for signing", d.sourceHash);
  hashRow("SHA-256 of the final signed PDF", d.finalHash);
  if (d.auditHead) hashRow("Audit trail chain head at completion", d.auditHead);
  text("Any change to either file changes its hash. Compare against the hash of your copy on the verification page.", { size: 8, color: C.muted });
  doc.moveDown(1);

  // Signers
  text("Signers and evidence", { bold: true, size: 12 });
  doc.moveDown(0.5);
  for (const s of d.signers) {
    ensure(96);
    const y0 = doc.y;
    doc.roundedRect(48, y0, W, 86, 5).lineWidth(0.6).strokeColor(C.rule).stroke();
    text(s.name, { bold: true, size: 11, x: 60, y: y0 + 9, width: W - 24 });
    text(`${s.email}${s.company ? ` · ${s.company}` : ""} · ${s.role.toLowerCase()}`, { size: 8.5, color: C.muted, x: 60, y: y0 + 25, width: W - 24 });
    const col = (label: string, val: string, x: number, y: number, w: number) => { text(label, { size: 7.5, color: C.muted, x, y, width: w }); doc.font("reg").fontSize(8.5).fillColor(C.text).text(hasRtl(val) ? rtl(val) : val, x, y + 10, { width: w }); };
    col(s.status === "COMPLETED" ? "Signed" : s.status === "DECLINED" ? "Declined" : "Status", s.status === "COMPLETED" ? `${fmt(s.signedAt)}` : s.status === "DECLINED" ? `${s.declineReason ?? "—"}` : s.status.toLowerCase(), 60, y0 + 44, 170);
    col("Signature method", s.methods.length ? s.methods.join(", ").toLowerCase() : "—", 240, y0 + 44, 90);
    col("Authentication", s.authMethod.replace(/_/g, " ").toLowerCase(), 340, y0 + 44, 90);
    col(d.includeIp ? "IP · device" : "Device", d.includeIp ? `${s.ip ?? "—"} · ${s.device}` : s.device, 440, y0 + 44, W - 440 + 48 - 8);
    doc.y = y0 + 96;
  }

  // Audit summary
  ensure(60);
  doc.moveDown(0.5);
  text("Audit trail summary", { bold: true, size: 12 });
  doc.moveDown(0.4);
  const shown = d.events.filter((e) => EVENT_LABEL[e.type] && e.type !== "document.version_created").slice(0, 80);
  for (const e of shown) {
    ensure(14);
    const y = doc.y;
    text(utc(e.at), { size: 7.8, color: C.muted, x: 48, y, width: 130 });
    text(EVENT_LABEL[e.type]!, { size: 8.5, x: 184, y: y - 0.5, width: 200 });
    text(e.actor, { size: 8.5, color: C.muted, x: 390, y: y - 0.5, width: W - 342 });
    doc.y = y + 13;
  }
  ensure(70);
  doc.moveDown(1);
  doc.moveTo(48, doc.y).lineTo(48 + W, doc.y).lineWidth(0.5).strokeColor(C.rule).stroke();
  doc.moveDown(0.5);
  text("This certificate records evidence collected by Bilit.event E-Sign while the document was signed: who signed, when, how they were authenticated, and cryptographic fingerprints of the documents. It does not by itself establish that the signatures are legally valid in any particular jurisdiction; that depends on the applicable law and the nature of the agreement.", { size: 7.5, color: C.muted });
  doc.moveDown(0.4);
  text(`Verify at ${d.verificationUrl}${d.brand.supportEmail ? ` · Support: ${d.brand.supportEmail}` : ""}`, { size: 7.5, color: C.muted });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // otherwise writing in the footer band spawns a blank page
    doc.font("reg").fontSize(7.5).fillColor(C.muted).text(`Bilit.event E-Sign · ${d.certificateId} · Page ${i + 1} of ${range.count}`, 48, doc.page.height - 38, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  return done;
}
