import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { decrypt, encrypt } from "../crypto";
import { AppError } from "../errors";
import type { RequestContext } from "../audit";
import { acctAudit, Currency, IsoDate, lockKey } from "./core";
import { EVENT_CODE_RE } from "./matcher";

type Actor = { orgId: string; userId: string; ctx: RequestContext };
const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

// ---------- organisers (created manually by an administrator; never derived from Stripe customers) ----------
export const BankDetails = z.object({ accountHolder: opt(140), iban: opt(40), bic: opt(15), bankName: opt(140), notes: opt(500) });
export const OrganiserInput = z.object({
  name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(200).optional().nullable().or(z.literal("").transform(() => null)),
  companyName: opt(200), vatNumber: opt(40), address: opt(1000), internalRef: opt(60), notes: opt(2000), active: z.boolean().default(true),
  bankDetails: BankDetails.optional().nullable(),
});
const bankHint = (b: z.infer<typeof BankDetails>) => {
  const iban = b.iban?.replace(/\s/g, "");
  return iban ? `${iban.slice(0, 4)} …${iban.slice(-4)}` : b.accountHolder ? `${b.accountHolder.slice(0, 20)}` : null;
};
type OrganiserRow = typeof schema.acctOrganisers.$inferSelect;
export const organiserView = (o: OrganiserRow, withBank = false) => {
  const { bankDetailsEnc, ...rest } = o;
  return { ...rest, hasBankDetails: !!bankDetailsEnc, bankDetails: withBank && bankDetailsEnc ? BankDetails.parse(JSON.parse(decrypt(bankDetailsEnc))) : undefined };
};
const auditable = (o: OrganiserRow) => ({ name: o.name, email: o.email, companyName: o.companyName, vatNumber: o.vatNumber, internalRef: o.internalRef, active: o.active, bankHint: o.bankHint });

function uniqueViolation(e: unknown, what: string): never {
  const code = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
  if (code === "23505") throw new AppError("conflict", `${what} is already in use.`);
  throw e;
}

export async function createOrganiser(a: Actor, input: z.infer<typeof OrganiserInput>) {
  return db.transaction(async (tx) => {
    const bank = input.bankDetails ? { bankDetailsEnc: encrypt(JSON.stringify(input.bankDetails)), bankHint: bankHint(input.bankDetails) } : {};
    const [o] = await tx.insert(schema.acctOrganisers).values({ organisationId: a.orgId, name: input.name, email: input.email ?? null, companyName: input.companyName, vatNumber: input.vatNumber, address: input.address, internalRef: input.internalRef, notes: input.notes, active: input.active, createdBy: a.userId, ...bank }).returning().catch((e) => uniqueViolation(e, "That internal organiser ID"));
    await acctAudit(tx, { ...a, action: "organiser.created", entity: "organiser", entityId: o!.id, new: auditable(o!) });
    return o!;
  });
}

export async function updateOrganiser(a: Actor, id: string, input: Partial<z.infer<typeof OrganiserInput>>, reason?: string | null) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, id), eq(schema.acctOrganisers.organisationId, a.orgId))).for("update");
    if (!before) throw new AppError("not_found", "Organiser not found");
    const { bankDetails, ...rest } = input;
    const bank = bankDetails === undefined ? {} : bankDetails === null ? { bankDetailsEnc: null, bankHint: null } : { bankDetailsEnc: encrypt(JSON.stringify(bankDetails)), bankHint: bankHint(bankDetails) };
    const [o] = await tx.update(schema.acctOrganisers).set({ ...rest, ...bank, updatedAt: new Date() }).where(eq(schema.acctOrganisers.id, id)).returning().catch((e) => uniqueViolation(e, "That internal organiser ID"));
    await acctAudit(tx, { ...a, action: "organiser.updated", entity: "organiser", entityId: id, old: auditable(before), new: auditable(o!), reason, extra: bankDetails !== undefined ? { bankDetailsChanged: true } : undefined });
    return o!;
  });
}

// ---------- events + agreements ----------
export const AgreementInput = z.object({
  percentBps: z.number().int().min(0).max(10_000).default(0),
  percentBasis: z.enum(["ADDED", "GROSS", "NET"]).default("ADDED"),
  fixedPerTicket: z.number().int().min(0).max(1_000_000_00).default(0),
  fixedEventFee: z.number().int().min(0).max(1_000_000_000_00).default(0),
  stripeFeesBorneBy: z.enum(["ORGANISER", "BILIT"]).default("ORGANISER"),
  chargebacksBorneBy: z.enum(["ORGANISER", "BILIT"]).default("ORGANISER"),
  refundsReverseCommission: z.boolean().default(true),
  notes: opt(1000),
});
export const EventInput = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().regex(EVENT_CODE_RE, "2–64 characters: letters, digits, dot, dash or underscore").transform((c) => c.toUpperCase()),
  currency: Currency, organiserId: z.string().uuid().optional().nullable(), startsOn: IsoDate.optional().nullable(),
  status: z.enum(["ACTIVE", "COMPLETED", "INACTIVE", "CANCELLED", "ARCHIVED"]).default("ACTIVE"), notes: opt(2000),
  agreement: AgreementInput,
});

async function assertOrganiser(tx: Tx, orgId: string, organiserId: string | null | undefined) {
  if (!organiserId) return;
  const [o] = await tx.select({ id: schema.acctOrganisers.id }).from(schema.acctOrganisers).where(and(eq(schema.acctOrganisers.id, organiserId), eq(schema.acctOrganisers.organisationId, orgId)));
  if (!o) throw new AppError("validation_failed", "Organiser not found.", [{ path: "organiserId", message: "Choose an organiser." }]);
}

async function addAgreement(tx: Tx, a: Actor, eventId: string, input: z.infer<typeof AgreementInput>) {
  await lockKey(tx, `agreement:${eventId}`);
  const [m] = await tx.select({ v: max(schema.acctAgreements.version) }).from(schema.acctAgreements).where(eq(schema.acctAgreements.eventId, eventId));
  const [ag] = await tx.insert(schema.acctAgreements).values({ organisationId: a.orgId, eventId, version: (m?.v ?? 0) + 1, ...input, createdBy: a.userId }).returning();
  await tx.update(schema.acctEvents).set({ currentAgreementId: ag!.id, updatedAt: new Date() }).where(eq(schema.acctEvents.id, eventId));
  return ag!;
}

export async function createEvent(a: Actor, input: z.infer<typeof EventInput>) {
  return db.transaction(async (tx) => {
    await assertOrganiser(tx, a.orgId, input.organiserId);
    const { agreement, ...e } = input;
    const [ev] = await tx.insert(schema.acctEvents).values({ organisationId: a.orgId, ...e, organiserId: e.organiserId ?? null, startsOn: e.startsOn ?? null, createdBy: a.userId }).returning().catch((x) => uniqueViolation(x, `Event code ${input.code}`));
    const ag = await addAgreement(tx, a, ev!.id, agreement);
    await acctAudit(tx, { ...a, action: "event.created", entity: "event", entityId: ev!.id, new: { ...e, agreement: { ...agreement, version: ag.version } } });
    return { ...ev!, currentAgreementId: ag.id };
  });
}

export const EventPatch = EventInput.omit({ agreement: true }).partial().extend({ reason: opt(500) });
export async function updateEvent(a: Actor, id: string, input: z.infer<typeof EventPatch>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, id), eq(schema.acctEvents.organisationId, a.orgId))).for("update");
    if (!before) throw new AppError("not_found", "Event not found");
    const { reason, ...patch } = input;
    if (patch.organiserId !== undefined) await assertOrganiser(tx, a.orgId, patch.organiserId);
    // Re-linking or re-coding an event that already has money booked is allowed but must be explained.
    if ((patch.code && patch.code !== before.code) || (patch.organiserId !== undefined && patch.organiserId !== before.organiserId) || (patch.currency && patch.currency !== before.currency)) {
      const [booked] = await tx.select({ id: schema.stripeBalanceTransactions.id }).from(schema.stripeBalanceTransactions).where(eq(schema.stripeBalanceTransactions.eventId, id)).limit(1);
      if (booked && !reason) throw new AppError("validation_failed", "This event already has transactions. Give a reason for changing its code, organiser or currency.", [{ path: "reason", message: "Reason required" }]);
    }
    const [ev] = await tx.update(schema.acctEvents).set({ ...patch, updatedAt: new Date() }).where(eq(schema.acctEvents.id, id)).returning().catch((x) => uniqueViolation(x, `Event code ${patch.code}`));
    const keys = Object.keys(patch) as Array<keyof typeof before>;
    await acctAudit(tx, { ...a, action: "event.updated", entity: "event", entityId: id, old: Object.fromEntries(keys.map((k) => [k, before[k]])), new: Object.fromEntries(keys.map((k) => [k, ev![k]])), reason });
    return ev!;
  });
}

/** New agreement version. Already-booked sales keep the version they were calculated with (no silent recalculation). */
export async function setAgreement(a: Actor, eventId: string, input: z.infer<typeof AgreementInput>, reason?: string | null) {
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(schema.acctEvents).where(and(eq(schema.acctEvents.id, eventId), eq(schema.acctEvents.organisationId, a.orgId))).for("update");
    if (!ev) throw new AppError("not_found", "Event not found");
    const [prev] = ev.currentAgreementId ? await tx.select().from(schema.acctAgreements).where(eq(schema.acctAgreements.id, ev.currentAgreementId)) : [];
    const ag = await addAgreement(tx, a, eventId, input);
    await acctAudit(tx, { ...a, action: "agreement.created", entity: "event", entityId: eventId, old: prev ?? null, new: ag, reason });
    return ag;
  });
}

export async function agreementsFor(orgId: string, eventId: string) {
  return db.select().from(schema.acctAgreements).where(and(eq(schema.acctAgreements.organisationId, orgId), eq(schema.acctAgreements.eventId, eventId))).orderBy(desc(schema.acctAgreements.version));
}
