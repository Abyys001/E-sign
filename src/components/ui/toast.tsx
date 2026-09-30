"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

type Toast = { id: number; kind: "ok" | "error" | "info"; text: string };
const Ctx = createContext<{ toast: (kind: Toast["kind"], text: string) => void }>({ toast: () => {} });
export const useToast = () => useContext(Ctx).toast;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const tr = useTranslations("common");
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "error" ? 8000 : 4500);
  }, []);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4 no-print">
        {items.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="pop pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border border-line-strong bg-fg px-4 py-3 text-sm text-bg shadow-card">
            {t.kind === "ok" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : t.kind === "error" ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
            <span>{t.text}</span>
            <button type="button" aria-label={tr("a11y.dismiss")} onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} className="ms-1 opacity-70 hover:opacity-100"><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
