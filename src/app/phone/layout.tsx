import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Bilit Phone",
  robots: { index: false, follow: false },
  manifest: "/phone/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Bilit Phone", statusBarStyle: "black-translucent" },
  icons: { apple: "/brand/bilit-mark-512.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, viewportFit: "cover", themeColor: "#0b0f0d" };
export const dynamic = "force-dynamic";

/** The phone app is a full-screen, installable call screen outside the finance app shell. */
export default function PhoneLayout({ children }: { children: React.ReactNode }) {
  return <div className="phone-app min-h-dvh bg-[#0b0f0d] text-white">{children}</div>;
}
