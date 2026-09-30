import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALES, DEFAULT_LOCALE, NAMESPACES, type AppLocale } from "./config";

export default getRequestConfig(async () => {
  const c = (await cookies()).get("locale")?.value;
  const locale: AppLocale = (LOCALES as readonly string[]).includes(c ?? "") ? (c as AppLocale) : DEFAULT_LOCALE;
  const parts = await Promise.all(NAMESPACES.map(async (n) => [n, (await import(`../../messages/${locale}/${n}.json`)).default] as const));
  return { locale, messages: Object.fromEntries(parts) };
});
