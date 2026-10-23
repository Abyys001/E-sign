"use client";
import { useTranslations } from "next-intl";
import { SubNav } from "@/components/accounting/kit";

export function StripeNav() {
  const t = useTranslations("accounting.stripe.nav");
  return <SubNav items={[{ href: "/accounting/stripe", label: t("connection") }, { href: "/accounting/stripe/payments", label: t("payments") }, { href: "/accounting/transactions", label: t("transactions") }, { href: "/accounting/stripe/payouts", label: t("payouts") }, { href: "/accounting/stripe/disputes", label: t("disputes") }, { href: "/accounting/stripe/sync", label: t("sync") }, { href: "/accounting/stripe/other", label: t("other") }]} />;
}
