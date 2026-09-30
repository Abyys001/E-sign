"use client";
import { useTranslations } from "next-intl";
import { ek } from "@/lib/i18n-key";

export function useAuditLabel() {
  const t = useTranslations("common.audit");
  return (type: string) => (t.has(ek(type) as never) ? t(ek(type) as never) : type);
}
