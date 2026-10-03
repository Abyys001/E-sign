import type { Condition } from "../clauses/condition";
import type { Module } from "../clauses/types";
import { PROMOTER_MASTER, PROMOTER_SCHEDULE } from "../clauses/library/promoter";
import { PROMOTER_GLOBAL } from "../clauses/library/promoter-global";

export type AgreementSelection = { clauseKey: string; required?: boolean; condition?: Condition };
export type AgreementTypeDef = {
  key: string;
  name: string;
  purpose: string;
  modules: Module[];
  /** Clauses selected by default. Each is optional in the selector unless `required`. */
  clauses: AgreementSelection[];
  /** Sections render in clause order with the document's own numbering (e.g. the user's global promoter agreement). */
  ordered?: boolean;
};

const CORE_HEAD: AgreementSelection[] = [
  { clauseKey: "parties.entities", required: true }, { clauseKey: "parties.authority", required: true }, { clauseKey: "event.details", required: true },
];
const CORE_TAIL: AgreementSelection[] = [
  { clauseKey: "compliance.licences" }, { clauseKey: "compliance.consumer_law" }, { clauseKey: "compliance.sanctions" }, { clauseKey: "compliance.anti_bribery" },
  { clauseKey: "confidentiality.mutual" }, { clauseKey: "data.protection", required: true }, { clauseKey: "insurance.cover" },
  { clauseKey: "indemnification.organiser" }, { clauseKey: "liability.limit", required: true }, { clauseKey: "warranties.mutual" }, { clauseKey: "force_majeure.general" },
  { clauseKey: "termination.standard", required: true }, { clauseKey: "suspension.standard" }, { clauseKey: "breach.remedies" },
  { clauseKey: "dispute.resolution" }, { clauseKey: "law.governing", required: true }, { clauseKey: "law.jurisdiction", required: true },
  { clauseKey: "general.notices" }, { clauseKey: "general.assignment" }, { clauseKey: "general.subcontracting" }, { clauseKey: "general.amendments" },
  { clauseKey: "general.entire_agreement" }, { clauseKey: "general.severability" }, { clauseKey: "general.waiver" },
  { clauseKey: "execution.counterparts" }, { clauseKey: "execution.esign", required: true }, { clauseKey: "execution.witnesses" },
  { clauseKey: "records.retention" }, { clauseKey: "records.audit" }, { clauseKey: "records.keeping" },
];
const TICKETING: AgreementSelection[] = [
  "ticketing.rights", "ticketing.inventory", "ticketing.pricing", "ticketing.allocation", "ticketing.scanning", "ticketing.validity", "ticketing.resale", "ticketing.complimentary", "ticketing.support",
  "obligations.organiser", "obligations.bilit",
  "exclusivity.grant", "exclusivity.exceptions", "exclusivity.breach", "exclusivity.non_exclusive",
  "financial.money_flow", "financial.revenue", "financial.booking_fee", "financial.processing_fee", "financial.commission", "financial.taxes", "financial.settlement", "financial.reserve", "financial.withheld", "financial.reconciliation", "financial.chargebacks",
  "compliance.ticketing_law", "compliance.accessibility",
].map((clauseKey) => ({ clauseKey, required: ["ticketing.rights", "financial.money_flow", "financial.settlement"].includes(clauseKey) }));
const REFUNDS: AgreementSelection[] = [
  "refunds.cancellation", "refunds.postponement", "refunds.window", "refunds.responsibility", "refunds.booking_fee", "refunds.processing_fee", "refunds.communication",
  ...["A", "B", "C", "D", "E", "F", "G", "H"].map((v) => `refunds.variant.${v}`),
].map((clauseKey) => ({ clauseKey, required: clauseKey === "refunds.cancellation" }));
const VENUE = ["venue.sourcing", "venue.negotiation", "venue.booking", "venue.deposits", "venue.obligations", "venue.cancellation"].map((clauseKey) => ({ clauseKey }));
const PRODUCTION = ["production.suppliers", "production.equipment", "production.staff", "production.security", "production.event_day", "production.health_safety", "compliance.event_safety"].map((clauseKey) => ({ clauseKey }));
const MARKETING = ["marketing.campaign_approval", "marketing.ad_spend", "marketing.social", "marketing.media", "marketing.creative", "marketing.reporting", "marketing.brand", "ip.marketing_assets", "ip.licence", "ip.bilit", "ip.organiser"].map((clauseKey) => ({ clauseKey }));
const ARTIST = ["artist.coordination", "artist.obligations", "artist.cancellation", "artist.rider", "artist.performance"].map((clauseKey) => ({ clauseKey }));

/**
 * The five agreements are compositions of shared service modules; no clause text is duplicated between them.
 */
export const AGREEMENT_TYPES: AgreementTypeDef[] = [
  { key: "ticketing_distribution", name: "Organizer – Bilit Event Ticketing & Distribution Agreement", purpose: "Ticket sales, booking fees, payment processing, settlements, ticket scanning, chargebacks, refunds and customer support.",
    modules: ["core", "ticketing"], clauses: [...CORE_HEAD, ...TICKETING, ...REFUNDS.filter((c) => c.clauseKey !== "refunds.postponement"), { clauseKey: "refunds.postponement" }, ...CORE_TAIL, { clauseKey: "ip.bilit" }, { clauseKey: "ip.organiser" }] },
  { key: "venue_production", name: "Organizer – Bilit Venue Sourcing & Event Production Services Agreement", purpose: "Venue sourcing, venue negotiation, production management, suppliers, staffing, equipment and event-day operations.",
    modules: ["core", "venue", "production", "staffing", "supplier", "event_day"], clauses: [...CORE_HEAD, ...VENUE, ...PRODUCTION, ...CORE_TAIL] },
  { key: "marketing_promotional", name: "Organizer – Bilit Event Marketing & Promotional Services Agreement", purpose: "Digital marketing, social media, advertising, media partnerships, promotional campaigns and marketing reporting.",
    modules: ["core", "marketing"], clauses: [...CORE_HEAD, ...MARKETING, ...CORE_TAIL] },
  { key: "full_event_management", name: "Organizer – Bilit Full Event Management & Production Agreement", purpose: "Comprehensive event management covering venue, production, ticketing, staffing, marketing, suppliers, artist coordination and event operations.",
    modules: ["core", "ticketing", "venue", "production", "marketing", "staffing", "artist", "supplier", "event_day"],
    clauses: [...CORE_HEAD, ...TICKETING, ...REFUNDS, ...VENUE, ...PRODUCTION, ...MARKETING, ...ARTIST, ...CORE_TAIL] },
  { key: "cancellation_refund", name: "Organizer – Bilit Event Cancellation, Refund & Rescheduling Agreement", purpose: "Event cancellation, postponement, rescheduling, customer refunds, refund eligibility, booking-fee treatment, payment-processing fees, chargebacks, organiser liabilities, force majeure, refund deadlines and the process for communicating cancellations or changes to ticket holders.",
    modules: ["core", "ticketing"], clauses: [...CORE_HEAD, ...REFUNDS, { clauseKey: "financial.money_flow", required: true }, { clauseKey: "financial.chargebacks" }, { clauseKey: "financial.reserve" }, { clauseKey: "financial.withheld" }, { clauseKey: "financial.booking_fee" }, { clauseKey: "financial.processing_fee" }, { clauseKey: "obligations.organiser" }, { clauseKey: "obligations.bilit" }, ...CORE_TAIL] },
  { key: "promoter_master", name: "Bilit.Events Promoter & Event Services Master Agreement", purpose: "Master terms for every event a promoter sells through Bilit: Bilit's role, promoter warranties, ticketing, booking fees, payment processing, settlement, advance payments, cancellation, refunds, chargebacks, liability, data protection, compliance and termination. Each event is added by an Event Schedule.",
    modules: ["core", "ticketing", "venue", "production", "marketing", "artist"], clauses: PROMOTER_MASTER.map((c) => ({ clauseKey: c.key, required: true })) },
  { key: "promoter_event_schedule", name: "Bilit.Events Event Schedule (under the Promoter Master Agreement)", purpose: "Per-event commercial terms that form part of the Promoter & Event Services Master Agreement: event details, ticket prices, booking fee, commission, settlement, advance, reserve, refund and cancellation terms, local law and special conditions.",
    modules: ["core", "ticketing"], clauses: PROMOTER_SCHEDULE.map((c) => ({ clauseKey: c.key, required: true })) },
  { key: "promoter_global", name: "Bilit.Events Promoter & Event Services Agreement (Global)", purpose: "One agreement per promoter covering all of their events (Bilit's own text, sections 1–64). Only the promoter's company details are needed; event and commercial details are agreed per event in Event Schedules.",
    modules: ["core", "ticketing"], ordered: true, clauses: PROMOTER_GLOBAL.map((c) => ({ clauseKey: c.key, required: true })) },
];
export const agreementType = (key: string) => AGREEMENT_TYPES.find((a) => a.key === key);
