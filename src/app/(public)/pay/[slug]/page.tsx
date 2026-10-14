import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accountingEnabled } from "@/server/accounting/core";
import { publicLink } from "@/server/accounting/payment-links";
import { PayPage } from "@/components/pay/pay-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payment", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function PaymentLinkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const link = accountingEnabled() ? await publicLink(slug) : null;
  if (!link) notFound();
  return <PayPage link={link} />;
}
