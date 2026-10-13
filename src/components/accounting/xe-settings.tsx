"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, useApi } from "@/lib/api";

type Xe = { connected: boolean; accountId: string | null; keyHint: string | null; lastAt: string | null; lastTarget: string | null; lastRates: Record<string, string>; lastError: string | null };

/** XE Currency Data API credentials: live mid-market rates for the converted (£) totals. */
export function XeSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.xe");
  const toast = useToast();
  const ensure = useElevation();
  const { data, reload } = useApi<Xe>("/api/accounting/settings/xe");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (data && accountId === null) setAccountId(data.accountId ?? ""); }, [data, accountId]);
  if (!data || accountId === null) return <Skeleton className="h-40" />;
  const save = async (remove = false) => {
    setBusy(true); setErr(null); setErrs({});
    try {
      if ((remove || apiKey) && !(await ensure())) return;
      await api("/api/accounting/settings/xe", { method: "PATCH", json: remove ? { accountId: null, apiKey: null } : { accountId: accountId || null, ...(apiKey ? { apiKey } : {}) } });
      setApiKey(""); if (remove) setAccountId(""); toast("ok", t("saved")); await reload();
    } catch (e) {
      setErr(errMsg(e));
      if (e instanceof ApiError && Array.isArray(e.details)) setErrs(Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])));
    } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title={t("title")} description={t("desc")} />
      <div className="space-y-4 p-5">
        {data.connected && <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-fin-pos" aria-hidden />{t("connected", { at: data.lastAt ? new Date(data.lastAt).toLocaleString() : "—" })}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("accountId")} error={errs.accountId}>{(p) => <Input {...p} disabled={!admin} autoComplete="off" value={accountId} onChange={(e) => setAccountId(e.target.value)} />}</Field>
          <Field label={t("apiKey")} error={errs.apiKey} hint={data.keyHint ? t("keySet", { hint: data.keyHint }) : t("keyHint")}>{(p) => <Input {...p} type="password" autoComplete="off" disabled={!admin} placeholder={data.keyHint ? "••••••••" : ""} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}</Field>
        </div>
        <p className="text-xs text-muted">{t("note")}</p>
        {data.lastError && <Callout tone="warn">{data.lastError}</Callout>}
        {err && <Callout tone="warn">{err}</Callout>}
        {admin && <div className="flex flex-wrap justify-end gap-2">{data.connected && <Button variant="ghost" loading={busy} onClick={() => save(true)}>{t("disconnect")}</Button>}<Button variant="primary" loading={busy} onClick={() => save()}>{t("save")}</Button></div>}
      </div>
    </Card>
  );
}
