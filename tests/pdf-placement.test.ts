import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { loadPdf, savePdf, stampItems } from "@/server/kit/pdf/stamp";
import { inspectPdf, assertSafeToProcess, PdfRejectedError } from "@/server/kit/pdf/pdf-inspect";
import { PdfLimitError } from "@/server/kit/pdf/limits";
import { pdfImageRects } from "./pdf-render-helper";

const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

const SIZES = {
  A4: [595.28, 841.89], Letter: [612, 792], A4Landscape: [841.89, 595.28], LetterLandscape: [792, 612],
} as const;

async function makePdf(w: number, h: number, rotate = 0) {
  const d = await PDFDocument.create();
  const p = d.addPage([w, h]);
  if (rotate) p.setRotation(degrees(rotate));
  return savePdf(d);
}

const rect = { page: 0, x: 0.2, y: 0.7, width: 0.3, height: 0.1 };

describe("signature placement lands where the sender put the field", () => {
  for (const [name, [w, h]] of Object.entries(SIZES)) {
    for (const rot of [0, 90, 180, 270]) {
      it(`${name} rotate=${rot}`, async () => {
        const bytes = await makePdf(w, h, rot);
        const doc = await loadPdf(bytes);
        // 1x1 image stretched? stamp fits aspect ratio, so use a rect-shaped image via exact-square field instead
        await stampItems(doc, [{ kind: "image", rect, format: "png", bytes: PNG_1x1 }]);
        const out = await savePdf(doc);
        const found = await pdfImageRects(out, 0);
        expect(found).toHaveLength(1);
        const f = found[0]!;
        // the image keeps its 1:1 aspect inside the field box: it must be centred in the field and fully inside it
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        expect(f.x + f.width / 2).toBeCloseTo(cx, 2);
        expect(f.y + f.height / 2).toBeCloseTo(cy, 2);
        expect(f.x).toBeGreaterThanOrEqual(rect.x - 1e-3);
        expect(f.x + f.width).toBeLessThanOrEqual(rect.x + rect.width + 1e-3);
        expect(f.y).toBeGreaterThanOrEqual(rect.y - 1e-3);
        expect(f.y + f.height).toBeLessThanOrEqual(rect.y + rect.height + 1e-3);
      });
    }
  }
});

describe("pdf preflight", () => {
  it("inspects geometry", async () => {
    const info = await inspectPdf(await makePdf(612, 792));
    expect(info.pageCount).toBe(1);
    expect(info.pages[0]!.box).toEqual([0, 0, 612, 792]);
  });
  it("rejects non-pdf bytes", async () => {
    await expect(inspectPdf(Buffer.from("not a pdf"))).rejects.toThrow();
  });
  it("rejects JavaScript / OpenAction", async () => {
    const d = await PDFDocument.create();
    d.addPage();
    d.addJavaScript("x", "app.alert(1)");
    await expect(assertSafeToProcess(await savePdf(d))).rejects.toBeInstanceOf(PdfRejectedError);
  });
  it("enforces limits", async () => {
    await expect(inspectPdf(await makePdf(612, 792), { maxBytes: 10, maxPages: 5 })).rejects.toBeInstanceOf(PdfLimitError);
  });
});
