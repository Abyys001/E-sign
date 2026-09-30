import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { dirOf, type AppLocale } from "@/i18n/config";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const gsf = localFont({ src: [{ path: "../fonts/GoogleSansFlex-latin.woff2", weight: "100 1000" }], variable: "--font-gsf", display: "swap" });
const vazir = localFont({ src: [{ path: "../fonts/Vazirmatn.woff2", weight: "100 900" }], variable: "--font-vazir", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Bilit.event E-Sign", template: "%s · Bilit.event E-Sign" },
  description: "Prepare, send and sign contracts with a complete audit trail.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f5f5f7" }, { media: "(prefers-color-scheme: dark)", color: "#0d0d12" }] };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await getLocale()) as AppLocale;
  const messages = await getMessages();
  const theme = (await cookies()).get("theme")?.value;
  return (
    <html lang={locale} dir={dirOf(locale)} data-theme={theme === "light" || theme === "dark" ? theme : undefined} className={`${gsf.variable} ${vazir.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
