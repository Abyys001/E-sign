import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { db, schema } from "@/db";

process.env.CONTRACT_STORAGE_LOCAL_DIR ??= mkdtempSync(path.join(tmpdir(), "esign-test-"));
process.env.CONTRACT_STORAGE_LOCAL_DIR = mkdtempSync(path.join(tmpdir(), "esign-test-"));

export async function makeOrg(name = "Test Org", role = "ORG_OWNER") {
  const slug = `t-${Math.random().toString(36).slice(2, 10)}`;
  const [org] = await db.insert(schema.organisations).values({ name, slug }).returning();
  const [user] = await db.insert(schema.users).values({ email: `${slug}@example.test`, name: "Tester", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ organisationId: org!.id, userId: user!.id, roleKey: role });
  return { org: org!, user: user! };
}

/** A small but real PDF: text on every page so page count / size are meaningful. */
export async function makePdf(pages = 2, size: [number, number] = [595.28, 841.89], rotate = 0): Promise<Buffer> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = d.addPage(size);
    p.drawText(`Test agreement — page ${i + 1}`, { x: 60, y: size[1] - 80, size: 18, font });
    if (rotate) p.setRotation(degrees(rotate));
  }
  return Buffer.from(await d.save());
}

// Rate limits are stored in the database and outlive a test run, so each run/file gets its own client IP instead of sharing one bucket.
const RUN_IP = `198.18.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
export const ctxFor = (over: Partial<{ ip: string; userAgent: string }> = {}) => ({ ip: over.ip ?? RUN_IP, userAgent: over.userAgent ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1", correlationId: "test", device: { os: "iOS", browser: "Safari", type: "mobile" } });

/** 1x1-ish valid PNG data URL big enough for the signature validator (>= 8x8). */
export function pngDataUrl(): string {
  // 16x8 transparent PNG generated once
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADbRvBiAAAAF0lEQVR42mNkYGD4z0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC";
  return `data:image/png;base64,${b64}`;
}

/** Drizzle wraps driver errors; the Postgres trigger message lives on `cause`. */
export async function expectPg(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e) {
    const msg = String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message);
    if (!re.test(msg)) throw new Error(`expected DB error matching ${re}, got: ${msg}`);
    return;
  }
  throw new Error(`expected DB error matching ${re}, but the statement succeeded`);
}
