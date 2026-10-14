import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { env } from "@/lib/env";
import { CURRENCY_RE } from "@/lib/money";
import { audit, type RequestContext } from "../audit";
import { AppError } from "../errors";
import { getOrgSettings } from "../settings";

export const accountingEnabled = () => env().ACCOUNTING_ENABLED === "true";
/** Every accounting route and job starts here: the module is invisible (404) on deployments that did not enable it. */
export function requireAccounting() {
  if (!accountingEnabled()) throw new AppError("not_found", "Not found");
}

export type Mode = "test" | "live";
export const ModeSchema = z.enum(["test", "live"]);
export const isLive = (m: Mode) => m === "live";
export const modeOf = (livemode: boolean): Mode => (livemode ? "live" : "test");

export const Currency = z.string().trim().toLowerCase().regex(CURRENCY_RE, "Use a 3-letter ISO currency code");
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ---------- chart of accounts ----------
export const SYSTEM_ACCOUNTS = {
  stripe_balance: { code: "1000", name: "Stripe Balance", type: "ASSET" },
  bank: { code: "1010", name: "Bank Account", type: "ASSET" },
  payouts_in_transit: { code: "1020", name: "Stripe Payouts in Transit", type: "ASSET" },
  organiser_receivable: { code: "1100", name: "Organiser Receivable", type: "ASSET" },
  organiser_payable: { code: "2000", name: "Amount Payable to Organisers", type: "LIABILITY" },
  unallocated_receipts: { code: "2900", name: "Unallocated Stripe Receipts", type: "LIABILITY" },
  unclassified: { code: "3900", name: "Unclassified Stripe Activity (suspense)", type: "EQUITY" },
  ticket_sales: { code: "4000", name: "Ticket Sales (gross)", type: "REVENUE" },
  bilit_commission: { code: "4100", name: "Bilit Commission & Fees", type: "REVENUE" },
  other_revenue: { code: "4200", name: "Other Revenue", type: "REVENUE" },
  organiser_share: { code: "4900", name: "Organiser Share of Ticket Sales (contra-revenue)", type: "REVENUE" },
  stripe_fees: { code: "5000", name: "Stripe Fees", type: "EXPENSE" },
  stripe_fee_recharges: { code: "5010", name: "Stripe Fees Recharged to Organisers (contra-expense)", type: "EXPENSE" },
  refunds: { code: "5100", name: "Refunds", type: "EXPENSE" },
  chargebacks: { code: "5200", name: "Chargebacks", type: "EXPENSE" },
  other_expenses: { code: "5900", name: "Other Expenses", type: "EXPENSE" },
  // bookkeeping
  cash: { code: "1030", name: "Cash", type: "ASSET" },
  vat_input: { code: "1200", name: "Input VAT / Tax Reclaimable", type: "ASSET" },
  accounts_payable: { code: "2100", name: "Accounts Payable (Supplier Invoices)", type: "LIABILITY" },
  net_wages_payable: { code: "2200", name: "Net Wages Payable", type: "LIABILITY" },
  payroll_liabilities: { code: "2210", name: "Payroll Taxes & Deductions Payable", type: "LIABILITY" },
  employee_reimbursements: { code: "2300", name: "Owed to Employees (Expenses Paid Personally)", type: "LIABILITY" },
  wages: { code: "6000", name: "Wages & Salaries (Gross)", type: "EXPENSE" },
  employer_payroll_costs: { code: "6010", name: "Employer Payroll Costs", type: "EXPENSE" },
  rent: { code: "6100", name: "Rent & Premises", type: "EXPENSE" },
  software: { code: "6200", name: "Software & Subscriptions", type: "EXPENSE" },
  marketing: { code: "6300", name: "Marketing & Advertising", type: "EXPENSE" },
  travel: { code: "6400", name: "Travel & Accommodation", type: "EXPENSE" },
  professional_fees: { code: "6500", name: "Accounting & Legal Fees", type: "EXPENSE" },
  office: { code: "6600", name: "Office & Equipment", type: "EXPENSE" },
  bank_charges: { code: "6700", name: "Bank Charges", type: "EXPENSE" },
  utilities: { code: "6800", name: "Utilities & Telecoms", type: "EXPENSE" },
  event_costs: { code: "6900", name: "Event Production Costs", type: "EXPENSE" },
  // profit share (e.g. web developer's % of each event's profit)
  profit_share: { code: "6950", name: "Profit Share (Partners)", type: "EXPENSE" },
  organiser_cashback: { code: "6960", name: "Organiser Cashback", type: "EXPENSE" },
  profit_share_payable: { code: "2400", name: "Profit Share Payable", type: "LIABILITY" },
} as const;
export type SystemAccount = keyof typeof SYSTEM_ACCOUNTS;
export type AccountIds = Record<SystemAccount, string>;

/** Idempotently create the system chart of accounts and the settings row for an organisation. */
export async function ensureLedgerSetup(tx: Tx | typeof db, orgId: string): Promise<AccountIds> {
  await tx.insert(schema.acctSettings).values({ organisationId: orgId }).onConflictDoNothing();
  const rows = await tx.select({ id: schema.acctAccounts.id, key: schema.acctAccounts.systemKey }).from(schema.acctAccounts).where(eq(schema.acctAccounts.organisationId, orgId));
  const have = new Map(rows.filter((r) => r.key).map((r) => [r.key!, r.id]));
  const missing = (Object.keys(SYSTEM_ACCOUNTS) as SystemAccount[]).filter((k) => !have.has(k));
  if (missing.length) {
    const ins = await tx.insert(schema.acctAccounts).values(missing.map((k) => ({ organisationId: orgId, systemKey: k, ...SYSTEM_ACCOUNTS[k] }))).onConflictDoNothing().returning({ id: schema.acctAccounts.id, key: schema.acctAccounts.systemKey });
    for (const r of ins) have.set(r.key!, r.id);
    if (ins.length < missing.length) {
      const again = await tx.select({ id: schema.acctAccounts.id, key: schema.acctAccounts.systemKey }).from(schema.acctAccounts).where(eq(schema.acctAccounts.organisationId, orgId));
      for (const r of again) if (r.key) have.set(r.key, r.id);
    }
  }
  return Object.fromEntries(have) as AccountIds;
}

// ---------- settings ----------
export const MatchRule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("METADATA"), key: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/) }),
  z.object({ type: z.literal("EXACT") }),
  z.object({ type: z.literal("PREFIX"), prefix: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_.-]+$/) }),
  z.object({ type: z.literal("REGEX"), pattern: z.string().min(1).max(200).refine((p) => { try { new RegExp(p); return /\((?!\?[:=!<])/.test(p); } catch { return false; } }, "Must be a valid regular expression with one capture group") }),
]);
export type MatchRule = z.infer<typeof MatchRule>;
/** Bilit checkout description: "Order (sL93xoK) for event: Blood In Blood Out Berlin (B41-0091), by Hussein Kaawar" → B41-0091. */
export const BILIT_DESCRIPTION_PATTERN = String.raw`for event:.*\(([A-Za-z0-9]+-[0-9]+)\)`;
/** Prefer metadata, then the code in Bilit's own order description, then any known event code anywhere in the description. */
export const DEFAULT_RULES: MatchRule[] = [{ type: "METADATA", key: "event_code" }, { type: "REGEX", pattern: BILIT_DESCRIPTION_PATTERN }, { type: "EXACT" }];

export type AcctSettings = { baseCurrency: string; defaultMode: Mode; matchRules: MatchRule[]; ticketQuantityKey: string; timezone: string; reportingCurrency: string | null; fxRates: Record<string, string>; bookingFeeRefundable: boolean };

export async function getAcctSettings(orgId: string, tx: Tx | typeof db = db): Promise<AcctSettings> {
  await ensureLedgerSetup(tx, orgId);
  const [s] = await tx.select().from(schema.acctSettings).where(eq(schema.acctSettings.organisationId, orgId));
  const rules = z.array(MatchRule).safeParse(s?.matchRules);
  const tz = (await getOrgSettings(orgId, tx)).general.timezone;
  const fx = FxRates.safeParse(s?.fxRates);
  return { baseCurrency: s?.baseCurrency ?? "eur", defaultMode: (s?.defaultMode as Mode) ?? "test", matchRules: rules.success && rules.data.length ? rules.data : DEFAULT_RULES, ticketQuantityKey: s?.ticketQuantityKey ?? "quantity", timezone: tz, reportingCurrency: s?.reportingCurrency ?? null, fxRates: fx.success ? fx.data : {}, bookingFeeRefundable: s?.bookingFeeRefundable ?? false };
}

/** Indicative reporting rates: 1 unit of the key currency = value units of the reporting currency. Never used for postings. */
export const FxRates = z.record(z.string().regex(/^[a-z]{3}$/), z.string().regex(/^\d{1,6}(\.\d{1,8})?$/, "Use a positive decimal rate").refine((v) => Number(v) > 0, "Rate must be positive")).refine((r) => Object.keys(r).length <= 50);

export const SettingsPatch = z.object({
  reportingCurrency: Currency.nullable().optional(),
  bookingFeeRefundable: z.boolean().optional(),
  fxRates: FxRates.optional(),
  baseCurrency: Currency.optional(),
  defaultMode: ModeSchema.optional(),
  matchRules: z.array(MatchRule).min(1).max(10).optional(),
  ticketQuantityKey: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/).optional(),
});

export async function updateAcctSettings(tx: Tx, orgId: string, userId: string, patch: z.infer<typeof SettingsPatch>, ctx: RequestContext) {
  const before = await getAcctSettings(orgId, tx);
  await tx.update(schema.acctSettings).set({ ...patch, updatedBy: userId, updatedAt: new Date() }).where(eq(schema.acctSettings.organisationId, orgId));
  const after = await getAcctSettings(orgId, tx);
  await acctAudit(tx, { orgId, userId, ctx, action: "settings.updated", old: pick(before, Object.keys(patch)), new: pick(after, Object.keys(patch)) });
  return after;
}
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// ---------- audit ----------
/** Accounting audit entries go into the organisation's tamper-evident audit chain with old/new values and a reason. */
export function acctAudit(tx: Tx, a: { orgId: string; userId?: string | null; ctx?: RequestContext; action: string; entity?: string; entityId?: string; old?: unknown; new?: unknown; reason?: string | null; extra?: Record<string, unknown> }) {
  return audit(tx, { organisationId: a.orgId, userId: a.userId ?? null, eventType: `accounting.${a.action}`, ctx: a.ctx, metadata: { entity: a.entity, entityId: a.entityId, old: a.old ?? null, new: a.new ?? null, reason: a.reason ?? null, ...a.extra } });
}

// ---------- dates / periods ----------
/** Calendar date (YYYY-MM-DD) of an instant in the organisation's timezone. */
export function localDate(d: Date, timezone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export async function isPeriodClosed(tx: Tx | typeof db, orgId: string, isoDate: string) {
  const [p] = await tx.select({ s: schema.acctPeriods.status }).from(schema.acctPeriods).where(and(eq(schema.acctPeriods.organisationId, orgId), eq(schema.acctPeriods.period, isoDate.slice(0, 7))));
  return p?.s === "CLOSED";
}

/**
 * Posting date for something that happened at `source`: its own date when that period is open, otherwise today
 * (late Stripe activity for a closed month lands in the current open period, keeping its original source date).
 */
export async function postingDate(tx: Tx | typeof db, orgId: string, source: Date, timezone: string): Promise<string> {
  const d = localDate(source, timezone);
  if (!(await isPeriodClosed(tx, orgId, d))) return d;
  const today = localDate(new Date(), timezone);
  if (await isPeriodClosed(tx, orgId, today)) throw new AppError("invalid_state", `Accounting period ${today.slice(0, 7)} is closed; reopen it to post.`);
  return today;
}

export const lockKey = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
