import type { Metadata } from "next";
import { IntakeFlow } from "@/components/intake/intake-flow";

export const metadata: Metadata = { title: "Secure form", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <IntakeFlow token={token} />;
}
