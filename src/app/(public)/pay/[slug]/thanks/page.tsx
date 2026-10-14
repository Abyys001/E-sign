import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accountingEnabled } from "@/server/accounting/core";
import { publicLink } from "@/server/accounting/payment-links";
import { PayThanks } from "@/components/pay/pay-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payment received", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function PaymentThanksPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ session_id?: string }> }) {
  const [{ slug }, { session_id }] = await Promise.all([params, searchParams]);
  const link = accountingEnabled() ? await publicLink(slug) : null;
  if (!link) notFound();
  return <PayThanks link={link} sessionId={session_id ?? ""} />;
}
