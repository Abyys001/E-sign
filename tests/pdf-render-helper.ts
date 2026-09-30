
/**
 * Renders nothing: asks pdf.js for the page's operator list, tracks the CTM through save/restore/transform,
 * and returns every painted image as fractions of the *displayed* (rotated) page, top-left origin.
 * This is how we prove stamped coordinates match what a viewer shows.
 */
export async function pdfImageRects(bytes: Uint8Array, pageIndex: number) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const { OPS } = pdfjs;
  const ops = await page.getOperatorList();
  type M = [number, number, number, number, number, number];
  const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const out: { x: number; y: number; width: number; height: number }[] = [];
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i] as unknown;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as M);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
        const ux = ctm[0] * u! + ctm[2] * v! + ctm[4];
        const uy = ctm[1] * u! + ctm[3] * v! + ctm[5];
        const [px, py] = vp.convertToViewportPoint(ux, uy);
        return [px! / vp.width, py! / vp.height] as const;
      });
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      out.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
  });
  return out;
}
