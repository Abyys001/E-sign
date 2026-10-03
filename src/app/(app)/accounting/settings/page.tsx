"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type Rule = { type: "METADATA"; key: string } | { type: "EXACT" } | { type: "PREFIX"; prefix: string } | { type: "REGEX"; pattern: string };
type S = { baseCurrency: string; defaultMode: "test" | "live"; matchRules: Rule[]; ticketQuantityKey: string; timezone: string; reportingCurrency: string | null; fxRates: Record<string, string> };

export default function FinanceSettings() {
  const t = useTranslations("accounting.settings");
  const tf = useTranslations("accounting.fin");
  const toast = useToast();
  const { can } = useMe();
  const { data, reload } = useApi<S>("/api/accounting/settings");
  const [v, setV] = useState<S | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data && !v) setV(data); }, [data, v]);
  if (!v) return <Skeleton className="h-64" />;
  const admin = can("accounting.admin");
  const setRule = (i: number, r: Rule) => setV({ ...v, matchRules: v.matchRules.map((x, j) => (j === i ? r : x)) });
  const move = (i: number, d: number) => { const r = [...v.matchRules]; const [x] = r.splice(i, 1); r.splice(i + d, 0, x!); setV({ ...v, matchRules: r }); };
  const save = async () => { setBusy(true); setErr(null); try { await api("/api/accounting/settings", { method: "PATCH", json: { baseCurrency: v.baseCurrency, defaultMode: v.defaultMode, matchRules: v.matchRules, ticketQuantityKey: v.ticketQuantityKey, reportingCurrency: v.reportingCurrency || null, fxRates: Object.fromEntries(Object.entries(v.fxRates).filter(([k, x]) => k && x)) } }); toast("ok", t("saved")); await reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("sub")} actions={<LinkButton href="/accounting/stripe">{t("stripe")}</LinkButton>} />
      <Card><CardHeader title={t("general")} /><div className="grid gap-4 p-5 sm:grid-cols-3">
        <Field label={t("base")} hint={t("baseHint")}>{(p) => <Input {...p} disabled={!admin} value={v.baseCurrency} maxLength={3} onChange={(e) => setV({ ...v, baseCurrency: e.target.value.toLowerCase() })} className="uppercase" />}</Field>
        <Field label={t("defaultMode")} hint={t("defaultModeHint")}>{(p) => <Select {...p} disabled={!admin} value={v.defaultMode} onChange={(e) => setV({ ...v, defaultMode: e.target.value as "test" })}><option value="test">TEST</option><option value="live">LIVE</option></Select>}</Field>
        <Field label={t("qtyKey")} hint={t("qtyKeyHint")}>{(p) => <Input {...p} disabled={!admin} value={v.ticketQuantityKey} onChange={(e) => setV({ ...v, ticketQuantityKey: e.target.value })} className="font-mono" />}</Field>
        <p className="text-xs text-muted sm:col-span-3">{t("timezone", { tz: v.timezone })}</p>
      </div></Card>
      <Card><CardHeader title={t("rules")} description={t("rulesDesc")} />
        <ol className="divide-y divide-line">{v.matchRules.map((r, i) => <li key={i} className="flex flex-wrap items-end gap-3 px-5 py-4">
          <span className="num grid size-7 place-items-center rounded-full border-2 border-fg text-xs font-semibold">{i + 1}</span>
          <Field label={t("ruleType")}>{(p) => <Select {...p} disabled={!admin} value={r.type} onChange={(e) => { const ty = e.target.value as Rule["type"]; setRule(i, ty === "METADATA" ? { type: ty, key: "event_code" } : ty === "PREFIX" ? { type: ty, prefix: "EVT-" } : ty === "REGEX" ? { type: ty, pattern: "\\b(EVT-[A-Z0-9-]+)\\b" } : { type: "EXACT" }); }} className="w-auto">{(["METADATA", "EXACT", "PREFIX", "REGEX"] as const).map((x) => <option key={x} value={x}>{t(`type.${x}`)}</option>)}</Select>}</Field>
          {r.type === "METADATA" && <Field label={t("key")}>{(p) => <Input {...p} disabled={!admin} value={r.key} onChange={(e) => setRule(i, { type: "METADATA", key: e.target.value })} className="font-mono" />}</Field>}
          {r.type === "PREFIX" && <Field label={t("prefix")}>{(p) => <Input {...p} disabled={!admin} value={r.prefix} onChange={(e) => setRule(i, { type: "PREFIX", prefix: e.target.value })} className="font-mono" />}</Field>}
          {r.type === "REGEX" && <div className="min-w-72 flex-1"><Field label={t("pattern")} hint={t("patternHint")}>{(p) => <Input {...p} disabled={!admin} value={r.pattern} onChange={(e) => setRule(i, { type: "REGEX", pattern: e.target.value })} className="font-mono" />}</Field></div>}
          {r.type === "EXACT" && <p className="flex-1 pb-2 text-sm text-muted">{t("exactDesc")}</p>}
          {admin && <div className="ms-auto flex gap-1 pb-0.5"><Button size="icon" aria-label={t("up")} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button><Button size="icon" aria-label={t("down")} disabled={i === v.matchRules.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button><Button size="icon" aria-label={t("remove")} disabled={v.matchRules.length === 1} onClick={() => setV({ ...v, matchRules: v.matchRules.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button></div>}
        </li>)}</ol>
        {admin && <div className="border-t border-line px-5 py-3"><Button size="sm" disabled={v.matchRules.length >= 10} onClick={() => setV({ ...v, matchRules: [...v.matchRules, { type: "PREFIX", prefix: "EVT-" }] })}><Plus className="size-4" aria-hidden />{t("addRule")}</Button></div>}
      </Card>
      <Card><CardHeader title={tf("fx.title")} description={tf("fx.desc")} /><div className="space-y-4 p-5">
        <Field label={tf("fx.currency")} hint={tf("fx.currencyHint")}>{(p) => <Input {...p} disabled={!admin} value={v.reportingCurrency ?? ""} maxLength={3} onChange={(e) => setV({ ...v, reportingCurrency: e.target.value.toLowerCase() || null })} className="w-28 uppercase" placeholder="gbp" />}</Field>
        {v.reportingCurrency && <ul className="space-y-2">{Object.entries(v.fxRates).map(([c, r], i) => <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span>1</span><Input aria-label={tf("fx.from")} disabled={!admin} value={c} maxLength={3} onChange={(e) => { const next = Object.entries(v.fxRates); next[i] = [e.target.value.toLowerCase(), r]; setV({ ...v, fxRates: Object.fromEntries(next) }); }} className="w-20 uppercase" />
          <span>=</span><Input aria-label={tf("fx.rate")} disabled={!admin} value={r} inputMode="decimal" onChange={(e) => setV({ ...v, fxRates: { ...v.fxRates, [c]: e.target.value } })} className="w-32 text-end" /><span className="uppercase">{v.reportingCurrency}</span>
          {admin && <Button size="icon" variant="ghost" aria-label={tf("fx.remove")} onClick={() => { const n = { ...v.fxRates }; delete n[c]; setV({ ...v, fxRates: n }); }}><Trash2 className="size-4" /></Button>}</li>)}</ul>}
        {admin && v.reportingCurrency && <Button size="sm" onClick={() => setV({ ...v, fxRates: { ...v.fxRates, "": "" } })} disabled={"" in v.fxRates}><Plus className="size-4" aria-hidden />{tf("fx.add")}</Button>}
        <p className="text-xs text-muted">{tf("fx.note")}</p>
      </div></Card>
      <Callout title={t("howTitle")}>{t("how")}</Callout>
      {err && <Callout tone="warn">{err}</Callout>}
      {admin && <div className="flex justify-end"><Button variant="primary" loading={busy} onClick={save}>{t("save")}</Button></div>}
    </div>
  );
}
