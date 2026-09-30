"use client";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmtNum } from "@/lib/api";
import { Button } from "./button";

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rtl = locale === "fa";
  return (
    <nav aria-label={t("a11y.pagination")} className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm">
      <span className="text-muted">{t("results", { count: total })}</span>
      <div className="flex items-center gap-2">
        <span className="num text-muted">{t("page", { page: fmtNum(page, locale), pages: fmtNum(pages, locale) })}</span>
        <Button size="icon" aria-label={t("previous")} disabled={page <= 1} onClick={() => onPage(page - 1)}>{rtl ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}</Button>
        <Button size="icon" aria-label={t("next")} disabled={page >= pages} onClick={() => onPage(page + 1)}>{rtl ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}</Button>
      </div>
    </nav>
  );
}
