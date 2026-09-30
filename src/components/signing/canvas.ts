"use client";
export const INK = "#0d0d12"; // palette --color-4

const family = () => (typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily);

export function renderTyped(text: string, w = 720, h = 240, italic = true): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d")!; if (!text.trim()) return "";
  let size = h * 0.5;
  const font = () => `${italic ? "italic " : ""}500 ${size}px ${family()}`;
  ctx.font = font();
  while (ctx.measureText(text).width > w - 48 && size > 14) { size -= 4; ctx.font = font(); }
  ctx.fillStyle = INK; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.fillText(text, w / 2, h / 2 + size * 0.04);
  return c.toDataURL("image/png");
}

/** Text that needs glyphs the PDF's standard font lacks (e.g. Persian) is rasterised here and stamped as an image. */
export function renderTextPng(text: string, boxW: number, boxH: number): string {
  const scale = 3, w = Math.max(60, Math.round(boxW * scale)), h = Math.max(24, Math.round(boxH * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  let size = h * 0.62; ctx.font = `400 ${size}px ${family()}`;
  while (ctx.measureText(text).width > w - 8 && size > 10) { size -= 2; ctx.font = `400 ${size}px ${family()}`; }
  const rtl = /[֐-ࣿ]/.test(text);
  ctx.fillStyle = INK; ctx.textBaseline = "middle"; ctx.direction = rtl ? "rtl" : "ltr"; ctx.textAlign = rtl ? "right" : "left";
  ctx.fillText(text, rtl ? w - 4 : 4, h / 2);
  return c.toDataURL("image/png");
}

export async function imageFileToDataUrl(file: File, maxW = 900): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image")); i.src = url; });
    const k = Math.min(1, maxW / img.width);
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } finally { URL.revokeObjectURL(url); }
}

const WIN = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export const isWinAnsi = (s: string) => [...s].every((ch) => ch.codePointAt(0)! <= 0xff || WIN.includes(ch));
