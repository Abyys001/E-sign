/**
 * TEST DATA ONLY. Adds a few clearly labelled draft contracts to an existing organisation so the UI has something to show
 * during local development. Nothing is sent, no email or SMS is queued, and every record is prefixed "[TEST DATA]".
 *   SEED_ORG_SLUG=<slug> npm run seed:test
 */
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { db, pool, schema } from "@/db";
import { addRecipient, createContract, saveFields, uploadVersion } from "@/server/contracts/service";

async function pdf(title: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595.28, 841.89]).drawText(`[TEST DATA] ${title}`, { x: 60, y: 760, size: 18, font: f });
  return Buffer.from(await d.save());
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed test data in production.");
  const slug = process.env.SEED_ORG_SLUG;
  const rows = await db.select({ org: schema.organisations, m: schema.memberships }).from(schema.memberships)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.memberships.organisationId))
    .where(slug ? eq(schema.organisations.slug, slug) : eq(schema.memberships.roleKey, "ORG_OWNER"))
    .orderBy(schema.organisations.createdAt);
  const pick = rows[0];
  if (!pick) throw new Error("No organisation found. Run `npm run bootstrap` first, or set SEED_ORG_SLUG.");
  const { org, m } = pick;
  const a = { orgId: org.id, userId: m.userId, ctx: { ip: "127.0.0.1", userAgent: "seed-test-data", correlationId: "seed", device: { os: "n/a", browser: "n/a", type: "desktop" } } };

  for (const [i, name] of ["Venue agreement", "Artist booking", "Sponsorship NDA"].entries()) {
    const bytes = await pdf(name);
    const c = await db.transaction((tx) => createContract(tx, a, { name: `[TEST DATA] ${name}`, contractType: "test", metadata: { testData: true } }));
    await db.transaction((tx) => uploadVersion(tx, a, c.id, bytes, "initial"));
    const r = await db.transaction((tx) => addRecipient(tx, a, c.id, { name: `Test Signer ${i + 1}`, email: `signer${i + 1}@example.test`, signingOrder: 1 }));
    await db.transaction((tx) => saveFields(tx, a, c.id, [{ id: `f_seed_${i}`, recipientId: r.id, type: "signature", rect: { page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }, required: true }]));
    console.log(`created ${c.reference} (${name})`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => pool.end());
