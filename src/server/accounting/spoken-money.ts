/**
 * Amounts as a person says them, for the voice call. The text-to-speech engine gets "9,808 euros and 18 cents" instead
 * of "€9,808.18", so a euro amount is never read as pounds and decimals are never mangled. The currency always comes
 * from the symbol or code written next to the number (as the finance tools format it) — never guessed.
 */
type Lang = "en" | "fa";
type Unit = { en: [string, string, string, string]; fa: [string, string] }; // en: major sg/pl, minor sg/pl · fa: major, minor

const UNITS: Record<string, Unit> = {
  GBP: { en: ["pound", "pounds", "penny", "pence"], fa: ["پوند", "پنس"] },
  EUR: { en: ["euro", "euros", "cent", "cents"], fa: ["یورو", "سنت"] },
  USD: { en: ["US dollar", "US dollars", "cent", "cents"], fa: ["دلار آمریکا", "سنت"] },
  CAD: { en: ["Canadian dollar", "Canadian dollars", "cent", "cents"], fa: ["دلار کانادا", "سنت"] },
  AUD: { en: ["Australian dollar", "Australian dollars", "cent", "cents"], fa: ["دلار استرالیا", "سنت"] },
  CHF: { en: ["Swiss franc", "Swiss francs", "centime", "centimes"], fa: ["فرانک سوئیس", "سانتیم"] },
  SEK: { en: ["Swedish krona", "Swedish kronor", "öre", "öre"], fa: ["کرون سوئد", "اوره"] },
  NOK: { en: ["Norwegian krone", "Norwegian kroner", "øre", "øre"], fa: ["کرون نروژ", "اوره"] },
  DKK: { en: ["Danish krone", "Danish kroner", "øre", "øre"], fa: ["کرون دانمارک", "اوره"] },
  TRY: { en: ["Turkish lira", "Turkish lira", "kuruş", "kuruş"], fa: ["لیر ترکیه", "کوروش"] },
  AED: { en: ["UAE dirham", "UAE dirhams", "fils", "fils"], fa: ["درهم امارات", "فلس"] },
  JPY: { en: ["Japanese yen", "Japanese yen", "", ""], fa: ["ین ژاپن", ""] },
};
const SYMBOL: Record<string, string> = { "£": "GBP", "€": "EUR", "US$": "USD", "$": "USD", "CA$": "CAD", "A$": "AUD", "JP¥": "JPY", "¥": "JPY" };

const NUM = String.raw`\d{1,3}(?:,\d{3})+|\d+`;
// "-£1,234.56", "€9,808.18", "SEK 1,500.00", "1,500.00 EUR"
const RE = new RegExp(String.raw`([-−])?(?:(US\$|CA\$|A\$|JP¥|[£€$¥])\s?|\b([A-Z]{3})\s)(${NUM})(?:\.(\d{1,2}))?(?![\d.,]*\d)|([-−])?\b(${NUM})(?:\.(\d{1,2}))?\s(GBP|EUR|USD|CAD|AUD|CHF|SEK|NOK|DKK|TRY|AED|JPY)\b`, "g");

const faDigits = (n: number) => new Intl.NumberFormat("fa-IR", { useGrouping: true }).format(n);

function words(neg: boolean, code: string, major: string, minorRaw: string | undefined, lang: Lang): string {
  const u = UNITS[code];
  const m = Number(major.replace(/,/g, ""));
  const minor = minorRaw ? Number(minorRaw.padEnd(2, "0")) : 0;
  if (lang === "fa") {
    const [maj, min] = u?.fa ?? [code, ""];
    if (!m && minor && min) return `${neg ? "منفی " : ""}${faDigits(minor)} ${min}`;
    return `${neg ? "منفی " : ""}${faDigits(m)} ${maj}${minor && min ? ` و ${faDigits(minor)} ${min}` : ""}`;
  }
  const [s, p, ms, mp] = u?.en ?? [code, code, "", ""];
  if (!m && minor && ms) return `${neg ? "minus " : ""}${minor} ${minor === 1 ? ms : mp}`;
  return `${neg ? "minus " : ""}${major} ${m === 1 ? s : p}${minor && ms ? ` and ${minor} ${minor === 1 ? ms : mp}` : ""}`;
}

/** Replace every formatted amount in `text` with its spoken form in `lang`. Text without amounts is unchanged. */
export function spokenMoney(text: string, lang: Lang): string {
  return text.replace(RE, (all, neg1, sym, codeA, num1, dec1, neg2, num2, dec2, codeB) => {
    const code = sym ? SYMBOL[sym] : codeA ?? codeB;
    if (!code || (codeA && !UNITS[codeA])) return all; // "ABC 12" that is not a currency we know: leave it
    return num1 !== undefined ? words(!!neg1, code, num1, dec1, lang) : words(!!neg2, code, num2, dec2, lang);
  });
}
