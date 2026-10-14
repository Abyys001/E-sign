import type { Metadata } from "next";
export const metadata: Metadata = { title: "Bilit Cards", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
/** The staff card portal is deliberately outside the organisation app shell — staff never see the main dashboard. */
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-bg text-fg">{children}</div>;
}
