"use client";
import { useTranslations } from "next-intl";
import { Checkbox, Field, Input, Select, SwitchField, Textarea } from "@/components/ui/form";

/** Client-side shape of PolicyConfig (server validates authoritatively). */
export type Policy = {
  exclusivity: { enabled: boolean; mode: string; scopeKind: string; events: string[]; territory: string; breachConsequences: string[]; cureDays: number; liquidatedSumText?: string; [k: string]: unknown };
  moneyFlow: { bookingFee: { enabled: boolean; paidBy: string; amountText?: string }; commission: { enabled: boolean; percent?: number }; refundsCustomers: string; holdsFunds: string; collectsTicketRevenue: string; settlesToOrganiser: string; settlement: { timing: string; days: number }; [k: string]: unknown };
  refund: { variant: string; deadlineDays: number; fundedBy: string; [k: string]: unknown };
  organiserObligations: string[]; bilitObligations: string[];
  execution: { level: string; witness: boolean; physicalPresence: boolean; deed: boolean; certificateRequired: boolean; trustedTimestampRequired: boolean; additionalFormalities: string[]; [k: string]: unknown };
  liability: { custom: boolean; capText: string };
  [k: string]: unknown;
};
export type Catalogue = { refundVariants: Record<string, { name: string; summary: string }>; organiserObligations: Record<string, string>; bilitObligations: Record<string, string> };

const PARTIES = ["bilit", "organiser", "payment_provider", "not_applicable"];
const BREACH = ["notice", "suspension", "fee_recovery", "liquidated_sum", "termination", "damages"];
const toggle = (xs: string[], k: string) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]);
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="space-y-3 border-t border-line px-4 py-4 first:border-t-0"><legend className="float-left mb-1 w-full text-sm font-semibold">{title}</legend><div className="clear-both space-y-3">{children}</div></fieldset>;
}

export function PolicyEditor({ value, onChange, catalogue, readOnly }: { value: Policy; onChange: (p: Policy) => void; catalogue: Catalogue; readOnly?: boolean }) {
  const t = useTranslations("intake.policy");
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => onChange({ ...value, [k]: v });
  const ex = value.exclusivity, mf = value.moneyFlow, rf = value.refund, xe = value.execution;
  const dis = !!readOnly;
  return (
    <div>
      <Section title={t("refund")}>
        <Field label={t("refundVariant")} hint={catalogue.refundVariants[rf.variant]?.summary}>{(p) => <Select {...p} disabled={dis} value={rf.variant} onChange={(e) => set("refund", { ...rf, variant: e.target.value })}>{Object.entries(catalogue.refundVariants).map(([k, v]) => <option key={k} value={k}>{k} — {v.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("deadlineDays")}>{(p) => <Input {...p} type="number" min={0} max={365} disabled={dis} value={rf.deadlineDays} onChange={(e) => set("refund", { ...rf, deadlineDays: Number(e.target.value) })} />}</Field>
          <Field label={t("fundedBy")}>{(p) => <Select {...p} disabled={dis} value={rf.fundedBy} onChange={(e) => set("refund", { ...rf, fundedBy: e.target.value })}>{["organiser", "bilit", "shared"].map((x) => <option key={x} value={x}>{t(`party.${x}` as never)}</option>)}</Select>}</Field>
        </div>
        <p className="text-xs text-muted">{t("refundNote")}</p>
      </Section>

      <Section title={t("exclusivity")}>
        <SwitchField checked={ex.enabled} disabled={dis} onChange={(v) => set("exclusivity", { ...ex, enabled: v })} label={t("exclusivityOn")} />
        {ex.enabled && <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("mode")}>{(p) => <Select {...p} disabled={dis} value={ex.mode} onChange={(e) => set("exclusivity", { ...ex, mode: e.target.value })}><option value="exclusive">{t("exclusive")}</option><option value="non_exclusive">{t("nonExclusive")}</option></Select>}</Field>
            <Field label={t("scope")}>{(p) => <Select {...p} disabled={dis} value={ex.scopeKind} onChange={(e) => set("exclusivity", { ...ex, scopeKind: e.target.value })}><option value="listed_events">{t("listedEvents")}</option><option value="all_events">{t("allEvents")}</option></Select>}</Field>
          </div>
          {ex.scopeKind === "listed_events" && <Field label={t("events")} hint={t("onePerLine")}>{(p) => <Textarea {...p} disabled={dis} defaultValue={ex.events.join("\n")} onBlur={(e) => set("exclusivity", { ...ex, events: lines(e.target.value) })} />}</Field>}
          <Field label={t("territory")}>{(p) => <Input {...p} disabled={dis} value={ex.territory} onChange={(e) => set("exclusivity", { ...ex, territory: e.target.value })} />}</Field>
          <div><p className="mb-1 text-sm font-medium">{t("breach")}</p><div className="grid gap-1.5 sm:grid-cols-2">{BREACH.map((b) => <Checkbox key={b} disabled={dis} label={t(`breachOpt.${b}` as never)} checked={ex.breachConsequences.includes(b)} onChange={() => set("exclusivity", { ...ex, breachConsequences: toggle(ex.breachConsequences, b) })} />)}</div></div>
          {ex.breachConsequences.includes("liquidated_sum") && <Field label={t("liquidated")}>{(p) => <Input {...p} disabled={dis} value={ex.liquidatedSumText ?? ""} onChange={(e) => set("exclusivity", { ...ex, liquidatedSumText: e.target.value })} />}</Field>}
          <p className="text-xs text-muted">{t("exclusivityNote")}</p>
        </>}
      </Section>

      <Section title={t("money")}>
        <div className="grid grid-cols-2 gap-3">
          {(["collectsTicketRevenue", "holdsFunds", "settlesToOrganiser", "refundsCustomers"] as const).map((k) => (
            <Field key={k} label={t(`flow.${k}` as never)}>{(p) => <Select {...p} disabled={dis} value={mf[k]} onChange={(e) => set("moneyFlow", { ...mf, [k]: e.target.value })}>{PARTIES.map((x) => <option key={x} value={x}>{t(`party.${x}` as never)}</option>)}</Select>}</Field>))}
        </div>
        <SwitchField checked={mf.bookingFee.enabled} disabled={dis} onChange={(v) => set("moneyFlow", { ...mf, bookingFee: { ...mf.bookingFee, enabled: v } })} label={t("bookingFee")} />
        {mf.bookingFee.enabled && <Field label={t("bookingFeePaidBy")}>{(p) => <Select {...p} disabled={dis} value={mf.bookingFee.paidBy} onChange={(e) => set("moneyFlow", { ...mf, bookingFee: { ...mf.bookingFee, paidBy: e.target.value } })}><option value="customer">{t("party.customer")}</option><option value="organiser">{t("party.organiser")}</option></Select>}</Field>}
        <SwitchField checked={mf.commission.enabled} disabled={dis} onChange={(v) => set("moneyFlow", { ...mf, commission: { ...mf.commission, enabled: v } })} label={t("commission")} />
        {mf.commission.enabled && <Field label={t("commissionPct")}>{(p) => <Input {...p} type="number" min={0} max={100} step="0.1" disabled={dis} value={mf.commission.percent ?? ""} onChange={(e) => set("moneyFlow", { ...mf, commission: { ...mf.commission, percent: e.target.value === "" ? undefined : Number(e.target.value) } })} />}</Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("settleTiming")}>{(p) => <Select {...p} disabled={dis} value={mf.settlement.timing} onChange={(e) => set("moneyFlow", { ...mf, settlement: { ...mf.settlement, timing: e.target.value } })}>{["after_event", "before_event", "rolling", "on_request"].map((x) => <option key={x} value={x}>{t(`timing.${x}` as never)}</option>)}</Select>}</Field>
          <Field label={t("settleDays")}>{(p) => <Input {...p} type="number" min={0} max={180} disabled={dis} value={mf.settlement.days} onChange={(e) => set("moneyFlow", { ...mf, settlement: { ...mf.settlement, days: Number(e.target.value) } })} />}</Field>
        </div>
      </Section>

      <Section title={t("obligations")}>
        <p className="text-sm font-medium">{t("organiserObl")}</p>
        <div className="grid gap-1.5">{Object.entries(catalogue.organiserObligations).map(([k, v]) => <Checkbox key={k} disabled={dis} label={v} checked={value.organiserObligations.includes(k)} onChange={() => set("organiserObligations", toggle(value.organiserObligations, k))} />)}</div>
        <p className="pt-2 text-sm font-medium">{t("bilitObl")}</p>
        <div className="grid gap-1.5">{Object.entries(catalogue.bilitObligations).map(([k, v]) => <Checkbox key={k} disabled={dis} label={v} checked={value.bilitObligations.includes(k)} onChange={() => set("bilitObligations", toggle(value.bilitObligations, k))} />)}</div>
      </Section>

      <Section title={t("execution")}>
        <p className="text-xs text-muted">{t("executionNote")}</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {(["witness", "physicalPresence", "deed", "certificateRequired", "trustedTimestampRequired"] as const).map((k) => <Checkbox key={k} disabled={dis} label={t(`exec.${k}` as never)} checked={xe[k]} onChange={() => set("execution", { ...xe, [k]: !xe[k] })} />)}
        </div>
        <Field label={t("execLevel")}>{(p) => <Select {...p} disabled={dis} value={xe.level} onChange={(e) => set("execution", { ...xe, level: e.target.value })}>{["SES", "AES", "QES"].map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
      </Section>

      <Section title={t("liability")}>
        <SwitchField checked={value.liability.custom} disabled={dis} onChange={(v) => set("liability", { ...value.liability, custom: v })} label={t("customCap")} />
        {value.liability.custom && <Field label={t("capText")}>{(p) => <Textarea {...p} disabled={dis} value={value.liability.capText} onChange={(e) => set("liability", { ...value.liability, capText: e.target.value })} />}</Field>}
      </Section>
    </div>
  );
}
