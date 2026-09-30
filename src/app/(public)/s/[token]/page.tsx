import type { Metadata } from "next";
import { SignFlow } from "@/components/signing/sign-flow";

export const metadata: Metadata = { title: "Sign document", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SignFlow token={token} />;
}
