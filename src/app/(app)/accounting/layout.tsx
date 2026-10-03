"use client";
import { useTranslations } from "next-intl";
import { FinanceGate, FinanceNav, ModeBanner, ModeSwitch } from "@/components/accounting/kit";

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("accounting");
  return (
    <FinanceGate>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("section")}</p>
        <ModeSwitch />
      </div>
      <FinanceNav />
      <ModeBanner />
      {children}
    </FinanceGate>
  );
}
