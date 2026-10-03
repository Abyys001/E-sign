"use client";
import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
import { ChatPanel } from "@/components/accounting/ai-chat";
import { AccountantPanel } from "@/components/accounting/accountant";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";

/** AI accountant: ask questions about the books, and run / read the AI bookkeeping review. */
export default function AiAccountantPage() {
  const t = useTranslations("accounting.aichat");
  return (
    <div className="space-y-6">
      <PageHeader title={<span className="flex items-center gap-2"><Bot className="size-6" aria-hidden />{t("pageTitle")}</span>} description={t("pageSub")} />
      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <Card className="overflow-hidden"><CardHeader title={t("title")} description={t("chatDesc")} /><ChatPanel /></Card>
        <div><AccountantPanel /></div>
      </div>
    </div>
  );
}
