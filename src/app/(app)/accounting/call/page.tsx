"use client";
import { useTranslations } from "next-intl";
import { Phone } from "lucide-react";
import { AccountantCall } from "@/components/accounting/ai-call";
import { PhoneSettingsCard } from "@/components/accounting/phone-settings";
import { LinkButton } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { useApi } from "@/lib/api";

/** Call the AI Accountant: a live, hands-free voice conversation about the books (read-only). */
export default function AccountantCallPage() {
  const t = useTranslations("accounting.aicall");
  const { data } = useApi<{ settings: { enabled: boolean } }>("/api/accounting/settings/ai/call");
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={<span className="flex items-center gap-2"><Phone className="size-6" aria-hidden />{t("pageTitle")}</span>} description={t("pageSub")} />
      {!data ? <Skeleton className="h-64" /> : data.settings.enabled ? <><AccountantCall /><PhoneSettingsCard /></> : (
        <Callout tone="info" title={t("off")}>{t("offHint")}<div className="mt-3"><LinkButton href="/accounting/settings#call" size="sm">{t("openSettings")}</LinkButton></div></Callout>
      )}
    </div>
  );
}
