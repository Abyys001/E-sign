/**
 * Builds the Bilit.Events Promoter & Event Services Agreement as a branded PDF and (optionally) publishes it as an
 * e-sign template with fillable fields wherever the text has a placeholder ([●] etc.).
 *
 *   npx tsx scripts/promoter-agreement/build.ts --out /path/agreement.pdf            # render only
 *   npx tsx scripts/promoter-agreement/build.ts --out /path/agreement.pdf --publish  # + create & publish template (org "Bilit")
 *   npx tsx scripts/promoter-agreement/build.ts --out /path/agreement.pdf --update <templateId>  # publish a new version of it
 *
 * Roles: "bilit" (order 1: fills the Registered Office, Schedules 1–4 and 6, signs) then "promoter" (order 2: party details,
 * Schedule 5 bank details, signs). Company details come from Finance settings → Invoices.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db, schema } from "@/db";
import { C, load } from "@/server/signing/certificate";
import { getInvoiceSettings, registrationLines } from "@/server/accounting/invoices";
import { createDraftVersion, createTemplate, publishVersion, updateDraftVersion } from "@/server/templates/service";

type Role = "bilit" | "promoter";
type FieldOut = { id: string; recipientId: Role; type: string; label: string; required: boolean; rect: { page: number; x: number; y: number; width: number; height: number }; options?: string[]; defaultValue?: string };

const args = process.argv.slice(2);
const outPath = args[args.indexOf("--out") + 1] ?? "promoter-agreement.pdf";
const publish = args.includes("--publish");
const updateId = args.includes("--update") ? args[args.indexOf("--update") + 1] : null;

const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.name, "Bilit"));
if (!org) throw new Error("Bilit organisation not found");
const co = await getInvoiceSettings(org.id);
const legal = co.legalName ?? "Bilit Platform FZ-LLC";
const reg = registrationLines(co);
const BILIT_SIGNER = { name: "Sina Najafi", position: "Director", email: "info@bilit.events" };
/** Sina Najafi always signs for Bilit (owner instruction); pre-filled on every contract from this template. */
const BILIT_ROLES = () => [
  { key: "bilit", name: `Bilit (${legal})`, role: "SIGNER", order: 1, required: true, defaultName: BILIT_SIGNER.name, defaultEmail: BILIT_SIGNER.email },
  { key: "promoter", name: "Promoter / Organiser", role: "SIGNER", order: 2, required: true },
];

const md = readFileSync(join(import.meta.dirname, "agreement.md"), "utf8");
const fnt = load();
const PW = 595.28, PH = 841.89, M = 54, TOP = 104, BOTTOM_M = 62, W = PW - 2 * M, DARK = "#14141b";
const doc = new PDFDocument({ size: "A4", bufferPages: true, margins: { top: TOP, bottom: BOTTOM_M, left: M, right: M }, info: { Title: "Promoter & Event Services Agreement", Author: legal, Subject: "Bilit.Events Promoter & Event Services Agreement" } });
doc.registerFont("reg", fnt.reg); doc.registerFont("bold", fnt.bold);
const chunks: Buffer[] = [];
doc.on("data", (c: Buffer) => chunks.push(c));
const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
let page = 0;
doc.on("pageAdded", () => { page++; });
const BOTTOM = PH - BOTTOM_M;
const ensure = (h: number) => { if (doc.y + h > BOTTOM) doc.addPage(); };

const fields: FieldOut[] = [];
const ids = new Set<string>();
const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
const fid = (role: Role, label: string) => { const base = `${role}_${slug(label)}`.slice(0, 60); let id = base, i = 2; while (ids.has(id)) id = `${base}_${i++}`; ids.add(id); return id; };

/** Inline **bold** rendering with automatic page breaks. */
function rich(t: string, x: number, width: number, o: { size?: number; bold?: boolean; color?: string; align?: "left" | "center" | "justify"; y?: number } = {}) {
  const segs = t.split(/(\*\*[^*]+\*\*)/).filter(Boolean);
  doc.fontSize(o.size ?? 9.5).fillColor(o.color ?? C.text);
  segs.forEach((s, i) => {
    const b = s.startsWith("**") && s.endsWith("**");
    doc.font(b || o.bold ? "bold" : "reg");
    const opts = { width, align: o.align ?? "left", continued: i < segs.length - 1, lineGap: 2 };
    if (i === 0) doc.text(b ? s.slice(2, -2) : s, x, o.y ?? doc.y, opts); else doc.text(b ? s.slice(2, -2) : s, opts);
  });
}
const plainH = (t: string, width: number, size = 9.5) => doc.font("reg").fontSize(size).heightOfString(t.replace(/\*\*/g, ""), { width, lineGap: 2 });

function box(role: Role, label: string, x: number, y: number, w: number, h: number, type: string, required: boolean, extra: Partial<FieldOut> = {}) {
  doc.save().roundedRect(x, y, w, h, 3).lineWidth(0.6).fillAndStroke(role === "bilit" ? "#f3f1fb" : "#eef6f3", role === "bilit" ? "#c9c2ea" : "#b7d9cc").restore();
  fields.push({ id: fid(role, label), recipientId: role, type, label, required, rect: { page, x: x / PW, y: y / PH, width: w / PW, height: h / PH }, ...extra });
}

const typeFor = (label: string) => /e-?mail/i.test(label) ? "email" : /date$/i.test(label) ? "date" : /^position$/i.test(label) ? "job_title" : /^(legal name|legal entity \/ name)$/i.test(label) ? "company" : /capacity/i.test(label) ? "number" : "text";

/** "Label: [●]" line → label + fillable box. */
function fieldLine(label: string, role: Role, required: boolean, o: { suffix?: string; type?: string; options?: string[]; defaultValue?: string; h?: number } = {}) {
  const h = o.h ?? 18;
  ensure(h + 8);
  const y = doc.y;
  doc.font("bold").fontSize(9.5).fillColor(C.text);
  const lw = doc.widthOfString(`${label}:`);
  doc.text(`${label}:`, M, y + (h - 11) / 2, { lineBreak: false });
  const bx = Math.max(M + 176, M + lw + 10);
  const sw = o.suffix ? doc.font("reg").widthOfString(o.suffix) + 6 : 0;
  box(role, label, bx, y, M + W - bx - sw, h, o.type ?? typeFor(label), required, { ...(o.options ? { options: o.options } : {}), ...(o.defaultValue ? { defaultValue: o.defaultValue } : {}) });
  if (o.suffix) doc.font("reg").fontSize(9.5).fillColor(C.text).text(o.suffix, M + W - sw + 6, y + (h - 11) / 2, { lineBreak: false });
  doc.x = M; doc.y = y + h + 7;
}
const valueLine = (label: string, value: string) => { ensure(16); const y = doc.y; doc.font("bold").fontSize(9.5).fillColor(C.text).text(`${label}:`, M, y, { lineBreak: false }); doc.font("reg").text(value, M + 176, y, { width: W - 176 }); doc.x = M; doc.y = Math.max(doc.y, y + 13) + 2; };

// ---------- render ----------
const lines = md.split("\n");
let section = "", sub = "", inTitle = true;
const roleNow = (): Role => /^1\./.test(sub) ? "bilit" : /^2\./.test(sub) ? "promoter" : /FOR BILIT/.test(sub) ? "bilit" : /FOR PROMOTER/.test(sub) ? "promoter" : /BANK DETAILS/.test(section) ? "promoter" : "bilit";

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i]!.trimEnd();
  const l = raw.trim();
  if (!l || l === "---") { if (l === "---") doc.y += 3; continue; }

  if (inTitle && /^#{1,2} /.test(l) && !/^# \d/.test(l)) {
    const big = l.startsWith("# ");
    rich(l.replace(/^#+ /, ""), M, W, { size: big ? 22 : 15, bold: true, align: "center", color: big ? C.primary : C.text });
    doc.y += big ? 2 : 4; continue;
  }
  if (inTitle && /^\*\*International/.test(l)) { rich(l.replace(/\*\*/g, ""), M, W, { size: 10.5, align: "center", color: C.muted }); doc.y += 14; continue; }
  if (/^### /.test(l)) { inTitle = false; sub = l.slice(4); ensure(40); doc.y += 6; rich(sub, M, W, { size: 11, bold: true, color: C.primary }); doc.y += 4; continue; }
  if (/^## /.test(l)) { sub = l.slice(3); doc.y += 6; ensure(190); rich(sub, M, W, { size: 11, bold: true, color: C.primary }); doc.y += 4; continue; }
  if (/^# /.test(l)) {
    inTitle = false; section = l.slice(2); sub = "";
    if (/^SCHEDULE\b/.test(section)) { doc.addPage(); rich("SCHEDULE", M, W, { size: 15, bold: true, align: "center" }); doc.y += 2; rich("Event details and commercial terms are agreed for each Event in a separate Event Schedule.", M, W, { size: 8.5, align: "center", color: C.muted }); doc.y += 10; }
    else if (/^65\./.test(section)) ensure(240);
    doc.y += 8; ensure(/^SCHEDULE/.test(section) ? 175 : 70);
    rich(section, M, W, { size: 11.5, bold: true, color: C.primary }); doc.y += 4; continue;
  }

  // table
  if (l.startsWith("|")) {
    const rows: string[][] = [];
    while (i < lines.length && lines[i]!.trim().startsWith("|")) { const r = lines[i]!.trim(); if (!/^\|[\s:|-]+\|$/.test(r)) rows.push(r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())); i++; }
    i--;
    const cw = [W * 0.24, W * 0.2, W * 0.16, W * 0.4], rh = 22;
    ensure(rh * rows.length + 6);
    rows.forEach((cells, ri) => {
      const y = doc.y; let x = M;
      if (ri === 0) doc.rect(M, y, W, rh).fill(C.tint);
      cells.forEach((c, ci) => {
        if (c === "[●]") box("bilit", `${cells[0]} — ${rows[0]![ci]}`, x + 3, y + 3, cw[ci]! - 6, rh - 6, ci === 2 ? "number" : "text", false);
        else doc.font(ri === 0 || ci === 0 ? "bold" : "reg").fontSize(9).fillColor(C.text).text(c, x + 5, y + 6.5, { width: cw[ci]! - 10, lineBreak: false });
        x += cw[ci]!;
      });
      doc.moveTo(M, y + rh).lineTo(M + W, y + rh).lineWidth(0.4).strokeColor(C.rule).stroke();
      doc.x = M; doc.y = y + rh;
    });
    doc.y += 8; continue;
  }

  const s = l.replace(/\*\*/g, "");
  // fixed Bilit details
  if (s.startsWith("Bilit.Events / [Full Legal Entity Name]")) { rich(`**Bilit.Events / ${legal}**`, M, W, { size: 10 }); doc.y += 4; continue; }
  if (/^1\./.test(sub)) {
    if (s.startsWith("Company Registration No.")) { valueLine("Company Registration No.", co.companyNumber ?? ""); if (co.customerNumber) valueLine("Customer No.", co.customerNumber); if (co.zone) valueLine("Zone", co.zone); continue; }
    if (s.startsWith("Registered Office")) { if (co.address) valueLine("Registered Office", co.address.replace(/\n+/g, ", ")); else fieldLine("Registered Office", "bilit", true, { defaultValue: co.registeredIn ? co.registeredIn.replace(/^the /, "").replace(/^./, (c) => c.toUpperCase()) : undefined }); continue; }
    if (s.startsWith("Email:")) { valueLine("Email", co.email ?? "info@bilit.events"); continue; }
    if (s.startsWith("Website:")) { valueLine("Website", "https://bilit.events"); continue; }
  }
  if (s.startsWith("Legal Entity: [BILIT LEGAL ENTITY]")) { valueLine("Legal Entity", legal); continue; }
  // Bilit's signatory is fixed (owner instruction): printed, not asked. Sina only applies the signature and date.
  if (/FOR BILIT/.test(sub)) {
    const fixed: Record<string, string> = { Name: BILIT_SIGNER.name, Position: BILIT_SIGNER.position, Email: BILIT_SIGNER.email };
    const k = s.match(/^(Name|Position|Email):/)?.[1];
    if (k) { valueLine(k, fixed[k]!); continue; }
  }
  if (/^Signature: _+/.test(s)) { ensure(56); const y = doc.y; doc.font("bold").fontSize(9.5).fillColor(C.text).text("Signature:", M, y + 16, { lineBreak: false }); box(roleNow(), `Signature — ${roleNow() === "bilit" ? "Bilit" : "Promoter"}`, M + 176, y, 220, 44, "signature", true); doc.x = M; doc.y = y + 52; continue; }
  if (/^Date: _+/.test(s)) { fieldLine("Date", roleNow(), true, { type: "date" }); continue; }
  if (s.startsWith("[Insert any special")) { ensure(140); const y = doc.y; box("bilit", "Event-specific special terms", M, y, W, 130, "long_text", false); doc.font("reg").fontSize(8).fillColor(C.muted).text("Insert any special commercial or operational terms (leave blank if none).", M + 6, y + 6, { lineBreak: false }); doc.x = M; doc.y = y + 138; continue; }
  const fm = s.match(/^(.+?):\s*\[(●|GBP \/ EUR \/ USD \/ Other)\](.*)$/);
  if (fm) {
    const label = fm[1]!.trim(), suffix = fm[3]!.trim() || undefined, role = roleNow();
    const req = role === "promoter" ? (/BANK DETAILS/.test(section) ? /^(Account Name|Bank Name|Currency)$/.test(label) : label !== "Trading Name")
      : /^65\./.test(section) ? true : /^(Event Name|Event Date|Venue|Settlement Currency|Bilit Booking Fee)$/.test(label);
    if (fm[2] !== "●") fieldLine(label, role, req, { type: "dropdown", options: ["GBP", "EUR", "USD", "SEK", "DKK", "AED", "Other"] });
    else fieldLine(label, role, req, { suffix });
    continue;
  }

  // lists and paragraphs
  let m: RegExpMatchArray | null;
  if ((m = l.match(/^- (.*)$/))) { ensure(14); const y = doc.y; doc.font("reg").fontSize(9.5).fillColor(C.text).text("•", M + 10, y, { lineBreak: false }); rich(m[1]!, M + 22, W - 22, { y }); doc.y += 1; continue; }
  if ((m = l.match(/^([a-z]|\d{1,2})\. (.*)$/))) { ensure(plainH(m[2]!, W - 30) + 4); const y = doc.y; doc.font("reg").fontSize(9.5).fillColor(C.text).text(`${m[1]}.`, M + 10, y, { lineBreak: false }); rich(m[2]!, M + 30, W - 30, { y }); doc.y += 3; continue; }
  if ((m = l.match(/^(\d{1,2}\.\d{1,2}) (.*)$/))) { ensure(Math.min(plainH(m[2]!, W - 34), 60) + 6); const y = doc.y; doc.font("bold").fontSize(9.5).fillColor(C.text).text(m[1]!, M, y, { lineBreak: false }); rich(m[2]!, M + 34, W - 34, { y, align: m[2]!.includes("**") ? "left" : "justify" }); doc.y += 5; continue; }
  if (/^\*\*END OF AGREEMENT\*\*$/.test(l)) { doc.y += 12; rich("END OF AGREEMENT", M, W, { bold: true, align: "center", color: C.muted }); continue; }
  ensure(Math.min(plainH(l, W), 60) + 6);
  rich(l, M, W, { align: l.includes("**") ? "left" : "justify" }); doc.y += 5;
}

// ---------- letterhead + footer on every page ----------
const range = doc.bufferedPageRange();
for (let p = 0; p < range.count; p++) {
  doc.switchToPage(p);
  const saved = doc.page.margins.bottom; doc.page.margins.bottom = 0;
  doc.rect(0, 0, PW, 70).fill(DARK); doc.rect(0, 70, PW, 3).fill(C.primary);
  doc.image(fnt.logo, M, 20, { height: 30 });
  doc.font("bold").fontSize(10.5).fillColor("#ffffff").text(legal, M, 20, { width: W, align: "right", lineBreak: false });
  doc.font("reg").fontSize(7.2).fillColor("#c7c7cc").text(reg.slice(0, 3).join("  ·  "), M, 36, { width: W, align: "right", lineBreak: false });
  doc.text(`${co.email ?? "info@bilit.events"}  ·  bilit.events`, M, 47, { width: W, align: "right", lineBreak: false });
  doc.moveTo(M, PH - 44).lineTo(M + W, PH - 44).lineWidth(0.5).strokeColor(C.rule).stroke();
  doc.font("reg").fontSize(7.5).fillColor(C.muted).text(`Promoter & Event Services Agreement  ·  ${legal}`, M, PH - 36, { width: W, align: "left", lineBreak: false });
  doc.text(`Page ${p + 1} of ${range.count}`, M, PH - 36, { width: W, align: "right", lineBreak: false });
  doc.page.margins.bottom = saved;
}
doc.end();
const pdf = await done;
writeFileSync(outPath, pdf);
console.log(`PDF ${outPath}: ${range.count} pages, ${fields.length} fields (bilit ${fields.filter((f) => f.recipientId === "bilit").length}, promoter ${fields.filter((f) => f.recipientId === "promoter").length})`);

if (publish) {
  const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.organisationId, org.id)).limit(1);
  const a = { orgId: org.id, userId: m!.userId, ctx: { ip: "127.0.0.1", userAgent: "admin-script", correlationId: "promoter-agreement-template" } };
  const roles = BILIT_ROLES();
  const payload = fields.map(({ defaultValue, ...f }) => ({ ...f, ...(defaultValue ? { defaultValue } : {}) }));
  const t = await db.transaction(async (tx) => {
    const { template, version } = await createTemplate(tx as never, a as never, { name: "Bilit.Events Promoter & Event Services Agreement", contractType: "promoter_agreement", pdf });
    await updateDraftVersion(tx as never, a as never, template.id, version.version, { recipientRoles: roles, fields: payload });
    await publishVersion(tx as never, a as never, template.id, version.version);
    return template;
  });
  console.log("published template", t.id);
}
if (updateId) {
  const roles = BILIT_ROLES();
  const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.organisationId, org.id)).limit(1);
  const a = { orgId: org.id, userId: m!.userId, ctx: { ip: "127.0.0.1", userAgent: "admin-script", correlationId: "promoter-agreement-template" } };
  const payload = fields.map(({ defaultValue, ...f }) => ({ ...f, ...(defaultValue ? { defaultValue } : {}) }));
  const v = await db.transaction(async (tx) => {
    const d = await createDraftVersion(tx as never, a as never, updateId);
    await updateDraftVersion(tx as never, a as never, updateId, d.version, { pdf, fields: payload, recipientRoles: roles });
    return publishVersion(tx as never, a as never, updateId, d.version);
  });
  console.log("published new version", v.version, "of template", updateId);
}
process.exit(0);
