"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";
import { toDecimalString } from "@/lib/money";

type S = { mode: "test" | "live"; connected: boolean; keyHint: string | null; financialAccountId: string | null; financialAccounts: Array<{ id: string; name: string | null; balances: Record<string, number> }>; lastTestedAt: string | null; lastError: string | null };

/** Stripe Global Payouts: the restricted key "Send money" uses and the financial account it pays from (per test/live mode). */
export function PayoutSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.payouts.settings");
  const toast = useToast();
  const ensure = useElevation();
  const { mode, q } = useMode();
  const { data, reload } = useApi<S>(q("/api/accounting/settings/payouts"));
  const [apiKey, setApiKey] = useState("");
  const [fa, setFa] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (data) setFa(data.financialAccountId ?? ""); }, [data]);
  if (!data || fa === null) return <Skeleton className="h-40" />;
  const save = async (remove = false) => {
    setBusy(true); setErr(null); setErrs({});
    try {
      if ((remove || apiKey) && !(await ensure())) return;
      await api("/api/accounting/settings/payouts", { method: "PATCH", json: remove ? { mode, apiKey: null } : { mode, ...(apiKey ? { apiKey } : {}), financialAccountId: fa || null } });
      setApiKey(""); toast("ok", remove ? t("removed") : t("saved")); await reload();
    } catch (e) {
      setErr(errMsg(e));
      if (e instanceof ApiError && Array.isArray(e.details)) setErrs(Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])));
    } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title={t("title", { mode: mode.toUpperCase() })} description={t("desc")} />
      <div className="space-y-4 p-5">
        {data.connected && !data.lastError && <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-fin-pos" aria-hidden />{t("connected", { at: data.lastTestedAt ? new Date(data.lastTestedAt).toLocaleString() : "—" })}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("key")} error={errs.apiKey} hint={data.keyHint ? t("keySet", { hint: data.keyHint }) : t("keyHint")}>{(p) => <Input {...p} type="password" autoComplete="off" disabled={!admin} placeholder={data.keyHint ? "••••••••" : mode === "live" ? "rk_live_…" : "rk_test_…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}</Field>
          <Field label={t("account")} hint={t("accountHint")}>{(p) => <Select {...p} disabled={!admin || !data.financialAccounts.length} value={fa} onChange={(e) => setFa(e.target.value)}>
            {!data.financialAccounts.length && <option value="">—</option>}
            {data.financialAccounts.map((f) => <option key={f.id} value={f.id}>{f.name ?? f.id} — {Object.entries(f.balances).map(([c, v]) => `${toDecimalString(v, c)} ${c.toUpperCase()}`).join(", ") || t("empty")}</option>)}
          </Select>}</Field>
        </div>
        <div className="text-xs text-muted"><p className="font-medium">{t("permsTitle")}</p><ul className="ms-4 list-disc">{(["p1", "p2", "p3", "p4", "p5"] as const).map((k) => <li key={k}>{t(`perms.${k}`)}</li>)}</ul><p className="mt-2">{t("note")}</p></div>
        {data.lastError && <Callout tone="warn">{data.lastError}</Callout>}
        {err && <Callout tone="warn">{err}</Callout>}
        {admin && <div className="flex flex-wrap justify-end gap-2">{data.connected && <Button variant="ghost" loading={busy} onClick={() => save(true)}>{t("remove")}</Button>}<Button variant="primary" loading={busy} disabled={!data.connected && !apiKey} onClick={() => save()}>{data.connected && !apiKey ? t("retest") : t("save")}</Button></div>}
      </div>
    </Card>
  );
}
