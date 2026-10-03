/**
 * Money helpers shared by server and browser. Amounts are integer minor units (as Stripe reports them); no floating point
 * arithmetic is ever applied to an amount. Display conversion is done on strings, never by dividing a float.
 */

/** Stripe zero-decimal currencies (https://docs.stripe.com/currencies#zero-decimal). */
const ZERO = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** Stripe three-decimal currencies (https://docs.stripe.com/currencies#three-decimal). */
const THREE = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export const currencyExponent = (currency: string) => (ZERO.has(currency.toLowerCase()) ? 0 : THREE.has(currency.toLowerCase()) ? 3 : 2);

export const CURRENCY_RE = /^[a-z]{3}$/;
export const normCurrency = (c: string) => c.trim().toLowerCase();

/** Exact decimal string for minor units: 1099 eur -> "10.99", -5 eur -> "-0.05", 500 jpy -> "500". */
export function toDecimalString(minor: number | bigint, currency: string): string {
  const exp = currencyExponent(currency);
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString();
  if (exp === 0) return `${neg ? "-" : ""}${abs}`;
  const padded = abs.padStart(exp + 1, "0");
  return `${neg ? "-" : ""}${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
}

/** Parse a user-entered major-unit decimal ("1,234.50", "10", "-3.2") into exact minor units. Throws on bad input. */
export function parseMajor(input: string, currency: string): number {
  const exp = currencyExponent(currency);
  const s = input.trim().replace(/[\s,_']/g, "");
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error("Enter an amount such as 1250.00");
  const frac = m[3] ?? "";
  if (frac.length > exp) throw new Error(exp === 0 ? "This currency has no decimal places" : `Use at most ${exp} decimal places`);
  const v = BigInt(m[2]! + frac.padEnd(exp, "0")) * (m[1] ? -1n : 1n);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large");
  return Number(v);
}

/** Round-half-away-from-zero integer division on bigint. */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d, r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  return twice >= (d < 0n ? -d : d) ? q + ((n < 0n) !== (d < 0n) ? -1n : 1n) : q;
}

/** amount × bps / 10 000, rounded half away from zero, computed exactly. 500 bps = 5 %. */
export function applyBps(amount: number, bps: number): number {
  if (!Number.isInteger(amount) || !Number.isInteger(bps)) throw new Error("applyBps needs integers");
  return Number(divRound(BigInt(amount) * BigInt(bps), 10_000n));
}

/**
 * Fee that was added on top of a price, recovered from the total paid: total × bps / (10 000 + bps).
 * €38.50 paid with a 10 % booking fee on top → €3.50 fee (ticket €35.00). Exact, half-away rounding.
 */
export function feeIncluded(total: number, bps: number): number {
  if (!Number.isInteger(total) || !Number.isInteger(bps)) throw new Error("feeIncluded needs integers");
  return Number(divRound(BigInt(total) * BigInt(bps), BigInt(10_000 + bps)));
}

/** part × numerator / denominator (pro-rata share of an integer amount), exact with half-away rounding. */
export function prorate(part: number, numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(divRound(BigInt(part) * BigInt(numerator), BigInt(denominator)));
}

/** "5.25" (percent) -> 525 bps. */
export function percentToBps(p: string): number {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(p.trim());
  if (!m) throw new Error("Enter a percentage such as 5 or 2.75");
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps > 10_000) throw new Error("Percentage cannot exceed 100");
  return bps;
}
export const bpsToPercent = (bps: number) => `${Math.trunc(bps / 100)}${bps % 100 ? `.${String(bps % 100).padStart(2, "0").replace(/0$/, "")}` : ""}`;

/** Locale-formatted money from minor units. Intl formats the exact decimal string, so no float rounding is involved. */
export function formatMoney(minor: number | null | undefined, currency: string, locale = "en"): string {
  if (minor == null) return "—";
  const exp = currencyExponent(currency);
  const nf = new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-GB", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: exp, maximumFractionDigits: exp });
  return nf.format(toDecimalString(minor, currency) as unknown as number);
}
