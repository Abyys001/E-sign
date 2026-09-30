"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { cn } from "./cn";
import { Skeleton } from "./feedback";

export type PageDim = { w: number; h: number };
type Props = {
  src: string;
  /** 1 = fit to container width. */
  zoom?: number;
  onLoaded?: (pages: PageDim[]) => void;
  onError?: (e: Error) => void;
  /** Absolutely-positioned layer per page; geometry is percent-based so it stays aligned at every zoom. */
  overlay?: (pageIndex: number) => React.ReactNode;
  pageProps?: (pageIndex: number) => React.HTMLAttributes<HTMLDivElement>;
  className?: string;
  maxWidth?: number;
};

let workerReady = false;
async function pdfjs() {
  const lib = await import("pdfjs-dist");
  if (!workerReady) { lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString(); workerReady = true; }
  return lib;
}

/** pdf.js canvas renderer. Pages render lazily when they approach the viewport; coordinates come from the CropBox in displayed orientation. */
export function PdfViewer({ src, zoom = 1, onLoaded, onError, overlay, pageProps, className, maxWidth = 960 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [dims, setDims] = useState<PageDim[]>([]);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const cb = useRef({ onLoaded, onError });
  cb.current = { onLoaded, onError };

  useEffect(() => {
    let dead = false;
    let task: PDFDocumentLoadingTask | null = null;
    setDoc(null); setDims([]); setFailed(false);
    (async () => {
      try {
        const lib = await pdfjs();
        task = lib.getDocument({ url: src, withCredentials: true });
        const d = await task.promise;
        const list: PageDim[] = [];
        for (let i = 1; i <= d.numPages; i++) { const v = (await d.getPage(i)).getViewport({ scale: 1 }); list.push({ w: v.width, h: v.height }); }
        if (dead) return;
        setDoc(d); setDims(list); cb.current.onLoaded?.(list);
      } catch (e) { if (!dead) { setFailed(true); cb.current.onError?.(e instanceof Error ? e : new Error("PDF failed to load")); } }
    })();
    return () => { dead = true; void task?.destroy(); };
  }, [src]);

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const base = Math.min(Math.max(width - 8, Math.min(240, maxWidth)), maxWidth);
  return (
    <div ref={box} className={cn("flex w-full flex-col items-center gap-4", className)}>
      {failed && <p role="alert" className="py-10 text-sm">⚠ The document could not be displayed.</p>}
      {!doc && !failed && <Skeleton className="h-[60vh] w-full max-w-3xl" />}
      {doc && width > 0 && dims.map((d, i) => (
        <PageCanvas key={i} doc={doc} index={i} cssWidth={base * zoom} ratio={d.h / d.w} overlay={overlay?.(i)} extra={pageProps?.(i)} />
      ))}
    </div>
  );
}

function PageCanvas({ doc, index, cssWidth, ratio, overlay, extra }: { doc: PDFDocumentProxy; index: number; cssWidth: number; ratio: number; overlay?: React.ReactNode; extra?: React.HTMLAttributes<HTMLDivElement> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(index < 2);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) setVisible(true); }, { rootMargin: "600px 0px" });
    io.observe(el); return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    let task: { cancel(): void; promise: Promise<unknown> } | undefined;
    let dead = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
      const c = canvas.current; if (!c || dead) return;
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      task = page.render({ canvasContext: c.getContext("2d")!, viewport: vp, canvas: c });
      try { await task.promise; } catch { /* cancelled by a newer render */ }
    })();
    return () => { dead = true; task?.cancel(); };
  }, [visible, doc, index, cssWidth]);
  return (
    <div ref={wrap} data-page={index} {...extra} className={cn("relative overflow-hidden rounded-md bg-white shadow-card ring-1 ring-line", extra?.className)} style={{ width: cssWidth, height: cssWidth * ratio, ...extra?.style }}>
      <canvas ref={canvas} className="absolute inset-0 size-full" aria-label={`Page ${index + 1}`} role="img" />
      {overlay && <div className="absolute inset-0">{overlay}</div>}
    </div>
  );
}
