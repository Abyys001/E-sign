"use client";
import { useLocale } from "next-intl";
import { Languages } from "lucide-react";

/** `onDark` is for headers that are dark in both themes, where theme surface tokens would render light-on-light. */
export function LocaleSwitch({ onDark = false }: { onDark?: boolean }) {
  const locale = useLocale();
  const next = locale === "en" ? "fa" : "en";
  return (
    <button type="button" onClick={() => { document.cookie = `locale=${next}; path=/; max-age=31536000; samesite=lax`; window.location.reload(); }}
      className={onDark ? "inline-flex items-center gap-2 rounded-xl border border-[var(--color-11)] px-3 py-2 text-sm text-[var(--color-1)] hover:bg-[var(--color-13)]" : "inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm hover:bg-surface-2"}>
      <Languages className="size-4" aria-hidden />{next === "fa" ? "فارسی" : "English"}
    </button>
  );
}
