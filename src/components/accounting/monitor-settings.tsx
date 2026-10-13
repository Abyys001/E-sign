"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, errMsg, useApi } from "@/lib/api";

type S = { refundRatePct: number; minOrders: number; feePctOverMedian: number; marginDropPct: number; expenseSpikeX: number; duplicateBillDays: number; webhookStaleHours: number; organiserPayDays: number; forecastRunRate: boolean };
const NUM: Array<keyof Omit<S, "forecastRunRate">> = ["refundRatePct", "minOrders", "feePctOverMedian", "marginDropPct", "expenseSpikeX", "duplicateBillDays", "webhookStaleHours", "organiserPayDays"];

/** Thresholds for the coded financial checks (alerts on the Financial Overview) and the cash-forecast assumptions. */
export function MonitorSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.monitor");
  const toast = useToast();
  const { data, reload } = useApi<{ settings: S; defaults: S }>("/api/accounting/settings/monitor");
  const [v, setV] = useState<Record<string, string | boolean> | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data && !v) setV(Object.fromEntries(Object.entries(data.settings).map(([k, x]) => [k, typeof x === "boolean" ? x : String(x)]))); }, [data, v]);
  if (!data || !v) return <Skeleton className="h-48" />;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const json: Record<string, number | boolean> = { forecastRunRate: !!v.forecastRunRate };
      for (const k of NUM) { const x = Number(v[k]); if (!Number.isFinite(x)) throw new Error(t("invalid", { field: t(`f.${k}`) })); json[k] = x; }
      await api("/api/accounting/settings/monitor", { method: "PATCH", json }); toast("ok", t("saved")); setV(null); await reload();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title={t("title")} description={t("desc")} />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {NUM.map((k) => <Field key={k} label={t(`f.${k}`)} hint={t(`h.${k}`, { d: data.defaults[k] })}>{(p) => <Input {...p} inputMode="decimal" disabled={!admin} value={String(v[k])} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}</Field>)}
        </div>
        <Checkbox label={t("f.forecastRunRate")} disabled={!admin} checked={!!v.forecastRunRate} onChange={(e) => setV({ ...v, forecastRunRate: e.target.checked })} />
        <p className="text-xs text-muted">{t("note")}</p>
        {err && <Callout tone="warn">{err}</Callout>}
        {admin && <div className="flex justify-end"><Button variant="primary" loading={busy} onClick={save}>{t("save")}</Button></div>}
      </div>
    </Card>
  );
}
