import { describe, expect, it } from "vitest";
import { evaluate } from "@/server/clauses/condition";
import { composeClauses, pickVariant, type ClauseVersionRow } from "@/server/clauses/compose";
import { SEED_CLAUSES } from "@/server/clauses/library";
import { AGREEMENT_TYPES } from "@/server/agreements/types";
import { renderText, UnresolvedVariablesError } from "@/server/variables/registry";
import { evaluateRefund, variantRules, BILIT_DEFAULT_LABEL } from "@/server/policy/refund-engine";
import { ExclusivityConfig, exclusivityVariables } from "@/server/policy/exclusivity";
import { MoneyFlowConfig, moneyFlowVariables } from "@/server/policy/money-flow";
import { evaluateSigningPolicy, DEFAULT_EXECUTION } from "@/server/legal/signing-policy";
import { computeLegalFlags, blocksAutoSign } from "@/server/legal/review-flags";
import { PolicyConfig, deriveVariables } from "@/server/policy/config";

describe("variables", () => {
  it("renders and refuses unresolved variables", () => {
    expect(renderText("Hi {{organiser_name}}", { organiser_name: "Example Events Ltd" })).toBe("Hi Example Events Ltd");
    expect(() => renderText("Hi {{organiser_name}} {{event_name}}", { organiser_name: "x" })).toThrow(UnresolvedVariablesError);
    expect(() => renderText("{{event_name}}", { event_name: "  " })).toThrow(UnresolvedVariablesError);
  });
  it("allows an explicit empty string only for declared optional variables", () => {
    expect(renderText("[{{x_note}}]", { x_note: "" }, undefined, new Set(["x_note"]))).toBe("[]");
    expect(() => renderText("[{{x_note}}]", { x_note: "" })).toThrow();
  });
  it("formats dates unambiguously", () => {
    expect(renderText("{{event_date}}", { event_date: "2026-11-05" })).toBe("5 November 2026");
  });
});

describe("conditions", () => {
  it("evaluates data-driven logic", () => {
    const ctx = { exclusive_ticketing: true, marketing_services: false, cancellation_policy: "custom" };
    expect(evaluate({ truthy: "exclusive_ticketing" }, ctx)).toBe(true);
    expect(evaluate({ truthy: "marketing_services" }, ctx)).toBe(false);
    expect(evaluate({ eq: ["cancellation_policy", "custom"] }, ctx)).toBe(true);
    expect(evaluate({ all: [{ truthy: "exclusive_ticketing" }, { not: { truthy: "marketing_services" } }] }, ctx)).toBe(true);
    expect(evaluate({ eq: ["exclusive_ticketing", false] }, { exclusive_ticketing: false })).toBe(true);
    expect(evaluate(null, ctx)).toBe(true);
  });
});

describe("clause library", () => {
  const keys = new Set(SEED_CLAUSES.map((c) => c.key));
  it("has unique keys", () => expect(keys.size).toBe(SEED_CLAUSES.length));
  it("every agreement type references only existing clauses, without duplicates", () => {
    for (const t of AGREEMENT_TYPES) {
      const ks = t.clauses.map((c) => c.clauseKey);
      expect(new Set(ks).size, t.key).toBe(ks.length);
      for (const k of ks) expect(keys.has(k), `${t.key} -> ${k}`).toBe(true);
    }
  });
  it("defines the five agreement types plus the promoter master + event schedule", () => expect(AGREEMENT_TYPES.map((t) => t.key)).toEqual(["ticketing_distribution", "venue_production", "marketing_promotional", "full_event_management", "cancellation_refund", "promoter_master", "promoter_event_schedule"]));
  it("does not duplicate clause text across agreements (modules compose shared clauses)", () => {
    const full = new Set(AGREEMENT_TYPES.find((t) => t.key === "full_event_management")!.clauses.map((c) => c.clauseKey));
    for (const k of ["ticketing.rights", "venue.sourcing", "marketing.social", "artist.rider"]) expect(full.has(k)).toBe(true);
  });
});

const row = (over: Partial<ClauseVersionRow>): ClauseVersionRow => ({ id: "1", clauseKey: "a", category: "GENERAL", module: "core", title: "A", version: 1, language: "en", jurisdiction: "ANY", body: "x", reviewStatus: "unreviewed", status: "PUBLISHED", condition: null, ...over });

describe("compose", () => {
  it("prefers exact > region > ANY and highest version; ignores drafts", () => {
    const c = [row({ id: "any1" }), row({ id: "any2", version: 2 }), row({ id: "uk", jurisdiction: "UK" }), row({ id: "eng", jurisdiction: "ENG" }), row({ id: "draft", jurisdiction: "ENG", version: 9, status: "DRAFT" })];
    expect(pickVariant(c, "ENG", "UK", "en")!.id).toBe("eng");
    expect(pickVariant(c, "SCO", "UK", "en")!.id).toBe("uk");
    expect(pickVariant(c, "DE", "EU", "en")!.id).toBe("any2");
    expect(pickVariant(c, "DE", "EU", "fa")).toBeNull();
  });
  it("omits clauses whose condition is false and reports unresolved variables", () => {
    const versions = new Map([["v1", row({ id: "v1", clauseKey: "ex", body: "Exclusive {{event_name}}", condition: { truthy: "exclusive_ticketing" } })], ["v2", row({ id: "v2", clauseKey: "core", body: "Hello {{organiser_name}}" })]]);
    const sel = [{ clauseKey: "ex", versionId: "v1" }, { clauseKey: "core", versionId: "v2" }];
    const off = composeClauses({ selection: sel, versions, values: { exclusive_ticketing: false, organiser_name: "X" } });
    expect(off.included.map((i) => i.clauseKey)).toEqual(["core"]);
    expect(off.excluded).toEqual([{ clauseKey: "ex", reason: "condition" }]);
    const on = composeClauses({ selection: sel, versions, values: { exclusive_ticketing: true } });
    expect(on.unresolved).toEqual({ event_name: ["ex"], organiser_name: ["core"] });
  });
});

describe("refund engine", () => {
  it("default Bilit policy: ticket refunded, booking fee retained, labelled as business policy not law", () => {
    const d = evaluateRefund({ reason: "organiser_cancellation", jurisdiction: "ENG", rules: [] });
    expect(d.ticket).toBe("refund");
    expect(d.bookingFee).toBe("retain");
    expect(d.bookingFeeLayer).toBe("bilit_default");
    expect(d.provenance.find((p) => p.component === "bookingFee")!.label).toBe(BILIT_DEFAULT_LABEL);
    expect(JSON.stringify(d)).not.toMatch(/by law/i);
  });
  it("hierarchy: law > consumer rights > contract > ticket terms > default", () => {
    const rules = [
      ...variantRules("A"),
      { id: "ticket", layer: "ticket_terms" as const, reasons: "*" as const, label: "Ticket terms", outcome: { bookingFee: "refund" as const } },
      { id: "law", layer: "law" as const, reasons: ["organiser_cancellation" as const], jurisdictions: ["US"], label: "State law", outcome: { bookingFee: "refund" as const } },
    ];
    expect(evaluateRefund({ reason: "organiser_cancellation", jurisdiction: "ENG", rules }).bookingFeeLayer).toBe("contract"); // law rule is US-only
    const us = evaluateRefund({ reason: "organiser_cancellation", jurisdiction: "US-NY", rules });
    expect(us.bookingFee).toBe("refund");
    expect(us.bookingFeeLayer).toBe("law");
  });
  it("contract variant B overrides the default booking-fee treatment", () => {
    const d = evaluateRefund({ reason: "force_majeure", jurisdiction: "ENG", rules: variantRules("B") });
    expect(d.bookingFee).toBe("refund");
    expect(d.bookingFeeLayer).toBe("contract");
  });
  it("handles every reason and reports unspecified instead of inventing results", () => {
    const none = evaluateRefund({ reason: "postponement", jurisdiction: "ENG", rules: [], disableDefaults: true });
    expect(none.unspecified).toContain("ticket");
    expect(none.ticket).toBe("unspecified");
    for (const r of ["organiser_cancellation", "venue_cancellation", "artist_cancellation", "government_restriction", "force_majeure", "postponement", "rescheduling", "event_date_change", "material_event_change", "duplicate_booking", "fraud", "payment_failure", "chargeback"] as const)
      expect(evaluateRefund({ reason: r, jurisdiction: "ENG", rules: [] }).ticket, r).not.toBe("unspecified");
  });
  it("flags same-layer conflicts", () => {
    const rules = [{ id: "1", layer: "contract" as const, reasons: "*" as const, label: "one", outcome: { bookingFee: "refund" as const } }, { id: "2", layer: "contract" as const, reasons: "*" as const, label: "two", outcome: { bookingFee: "retain" as const } }];
    expect(evaluateRefund({ reason: "organiser_cancellation", jurisdiction: "ENG", rules }).conflicts.length).toBe(1);
  });
});

describe("exclusivity + money flow", () => {
  it("only emits exclusivity variables when enabled and validates config", () => {
    expect(exclusivityVariables(ExclusivityConfig.parse({}))).toEqual({ exclusive_ticketing: false });
    expect(() => ExclusivityConfig.parse({ enabled: true, scopeKind: "listed_events", events: [] })).toThrow();
    const v = exclusivityVariables(ExclusivityConfig.parse({ enabled: true, events: ["Gala"], breachConsequences: ["notice", "suspension"] }));
    expect(v.exclusive_ticketing).toBe(true);
    expect(String(v.exclusivity_events)).toContain("Gala");
  });
  it("does not invent unselected financial obligations", () => {
    const v = moneyFlowVariables(MoneyFlowConfig.parse({}));
    expect(v.reserve_enabled).toBe(false);
    expect(v.commission_enabled).toBe(false);
    expect(v.chargebacks_enabled).toBe(false);
    expect(() => MoneyFlowConfig.parse({ reserve: { enabled: true } })).toThrow();
  });
});

describe("signing policy + legal flags", () => {
  it("supports simple e-signature with OTP", () => expect(evaluateSigningPolicy(DEFAULT_EXECUTION, "ENG").autoSignAllowed).toBe(true));
  it("stops automatic signing for qualified signatures, witnesses, deeds — never fakes them", () => {
    for (const over of [{ level: "QES" as const }, { level: "AES" as const }, { witness: true }, { deed: true }, { physicalPresence: true }, { additionalFormalities: ["Notarisation"] }]) {
      const d = evaluateSigningPolicy({ ...DEFAULT_EXECUTION, ...over }, "ENG");
      expect(d.autoSignAllowed).toBe(false);
      expect(d.flag).toBe("Additional execution formalities required.");
    }
  });
  it("raises review flags without blocking normal use", () => {
    const f = computeLegalFlags({ jurisdiction: "OTHER", execution: DEFAULT_EXECUTION, clauses: [{ key: "a", reviewStatus: "unreviewed" }], refundVariant: "D" });
    expect(f.map((x) => x.code)).toEqual(expect.arrayContaining(["jurisdiction.non_standard", "clauses.unreviewed", "refund.custom"]));
    expect(blocksAutoSign(f)).toBe(false);
    expect(blocksAutoSign(computeLegalFlags({ jurisdiction: "ENG", execution: { ...DEFAULT_EXECUTION, witness: true }, clauses: [] }))).toBe(true);
  });
});

describe("policy variables", () => {
  it("policy-derived values are complete for the default config", () => {
    const v = deriveVariables(PolicyConfig.parse({}), "ENG");
    expect(v.governing_law).toBe("the laws of England and Wales");
    expect(v.refund_booking_fee_text).toBe("retained by Bilit");
    expect(v.exclusive_ticketing).toBe(false);
  });
});
