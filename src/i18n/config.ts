export const LOCALES = ["en", "fa"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "en";
export const RTL_LOCALES: readonly AppLocale[] = ["fa"];
export const dirOf = (l: AppLocale) => (RTL_LOCALES.includes(l) ? "rtl" : "ltr");
/** One JSON file per area keeps translations reviewable; en and fa must define identical keys (tests/i18n.test.ts). */
export const NAMESPACES = ["common", "auth", "app", "contracts", "editor", "signing", "settings", "verify", "intake", "accounting", "treasury"] as const;
