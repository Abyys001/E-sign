"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, Bot, CheckCircle2, CircleHelp, FileArchive, FileText, Info, ShieldAlert, Sparkles } from "lucide-react";
import { useElevation } from "@/components/app/elevate";
import { useMe } from "@/components/app/me";
import { useMode } from "@/components/accounting/kit";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, errMsg, fmtDate, useApi } from "@/lib/api";
import { formatMoney } from "@/lib/money";

type Check = { severity: "high" | "medium" | "low"; code: string; title: string; detail: string; count: number; amounts?: Record<string, number> };
type Finding = { severity: "high" | "medium" | "low"; area: string; title: string; detail: string; recommendation: string; currency?: string | null; amount?: number | null };
type Review = { id: string; rangeFrom: string; rangeTo: string; model: string; status: string; error: string | null; createdAt: string; userName: string | null; result: { overallStatus: string; summary: string; findings: Finding[]; questionsForAccountant: string[]; goodPractice: string[] } | null };
const SEV = { high: "border-fin-neg/40 bg-fin-neg/10 text-fin-neg", medium: "border-fin-warn/40 bg-fin-warn/10 text-fin-warn", low: "border-fin-info/40 bg-fin-info/10 text-fin-info" };
const firstOfYear = () => `${new Date().getUTCFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

/** Accountant pack (PDF + CSVs), automated review checks and the AI accountant review. */
export function AccountantPanel() {
  const t = useTranslations("accounting.acc");
  const locale = useLocale();
  const toast = useToast();
  const ensure = useElevation();
  const { can } = useMe();
  const { q } = useMode();
  const [r, setR] = useState({ from: firstOfYear(), to: today() });
  const checks = useApi<{ checks: Check[] }>(q(`/api/accounting/reports/accountant?from=${r.from}&to=${r.to}&format=checks`));
  const reviews = useApi<{ items: Review[] }>("/api/accounting/ai/reviews");
  const ai = useApi<{ enabled: boolean; hasKey: boolean; model: string }>("/api/accounting/settings/ai");
  const [busy, setBusy] = useState(false);
  const download = async (format: "zip" | "pdf") => { if (await ensure()) window.location.href = q(`/api/accounting/reports/accountant?from=${r.from}&to=${r.to}&format=${format}`); };
  const runAi = async () => { setBusy(true); try { await api(q("/api/accounting/ai/reviews"), { json: r }); toast("ok", t("aiDone")); await reviews.reload(); } catch (e) { toast("error", errMsg(e)); await reviews.reload(); } finally { setBusy(false); } };
  const latest = reviews.data?.items.find((x) => x.status === "SUCCEEDED");
  return (
    <Card className="mb-6">
      <CardHeader title={t("title")} description={t("desc")} />
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("from")}>{(p) => <Input {...p} type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} className="w-auto" />}</Field>
          <Field label={t("to")}>{(p) => <Input {...p} type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} className="w-auto" />}</Field>
          <Button variant="primary" onClick={() => download("zip")}><FileArchive className="size-4" aria-hidden />{t("zip")}</Button>
          <Button onClick={() => download("pdf")}><FileText className="size-4" aria-hidden />{t("pdf")}</Button>
          {can("accounting.manage") && <Button loading={busy} disabled={!ai.data?.enabled} onClick={runAi} title={!ai.data?.enabled ? t("aiDisabled") : undefined}><Sparkles className="size-4" aria-hidden />{t("runAi")}</Button>}
        </div>
        <p className="text-xs text-muted">{t("packNote")}</p>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="size-4" aria-hidden />{t("checks")}</h3>
          {!checks.data ? <Skeleton className="h-16" /> : !checks.data.checks.length ? <p className="flex items-center gap-2 text-sm text-fin-pos"><CheckCircle2 className="size-4" aria-hidden />{t("noIssues")}</p> : (
            <ul className="space-y-2">{checks.data.checks.map((c) => <li key={c.code} className={cn("rounded-xl border p-3 text-sm", SEV[c.severity])}>
              <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-semibold">{c.title}{c.count ? ` (${c.count})` : ""}</span><span className="text-xs font-medium">{Object.entries(c.amounts ?? {}).map(([k, v]) => formatMoney(v, k, locale)).join(" · ")}</span></div>
              <p className="mt-1 text-xs text-fg/80">{c.detail}</p></li>)}</ul>)}
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" aria-hidden />{t("aiTitle")}</h3>
          {!ai.data?.enabled && <Callout icon={<Info className="size-4" aria-hidden />}>{t("aiSetup")}</Callout>}
          {latest?.result && <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-semibold", latest.result.overallStatus === "good" ? SEV.low : latest.result.overallStatus === "serious_issues" ? SEV.high : SEV.medium)}>{t(`status.${latest.result.overallStatus}`)}</span><span className="text-xs text-muted">{latest.rangeFrom} – {latest.rangeTo} · {latest.model} · {fmtDate(latest.createdAt, locale)} · {latest.userName}</span></div>
            <p className="text-sm">{latest.result.summary}</p>
            <ul className="space-y-2">{latest.result.findings.map((f, i) => <li key={i} className={cn("rounded-xl border p-3 text-sm", SEV[f.severity])}>
              <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-3.5" aria-hidden />{f.title}</span><span className="text-xs">{f.area}{f.amount != null && f.currency ? ` · ${formatMoney(Math.round(f.amount * 100), f.currency, locale)}` : ""}</span></div>
              <p className="mt-1 text-xs text-fg/80">{f.detail}</p><p className="mt-1 text-xs font-medium text-fg">→ {f.recommendation}</p></li>)}</ul>
            {latest.result.questionsForAccountant.length > 0 && <div><p className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><CircleHelp className="size-4" aria-hidden />{t("questions")}</p><ul className="list-disc space-y-1 ps-6 text-sm">{latest.result.questionsForAccountant.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            {latest.result.goodPractice.length > 0 && <div><p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-fin-pos"><CheckCircle2 className="size-4" aria-hidden />{t("good")}</p><ul className="list-disc space-y-1 ps-6 text-sm">{latest.result.goodPractice.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            <p className="text-xs text-muted">{t("aiDisclaimer")}</p>
          </div>}
          {reviews.data?.items[0]?.status === "FAILED" && <Callout tone="warn" title={t("aiFailed")}>{reviews.data.items[0].error}</Callout>}
        </section>
      </div>
    </Card>
  );
}

/** Finance settings → AI accountant (OpenAI). */
export function AiSettingsCard({ admin }: { admin: boolean }) {
  const t = useTranslations("accounting.acc.ai");
  const toast = useToast();
  const ensure = useElevation();
  const { data, reload } = useApi<{ enabled: boolean; model: string; hasKey: boolean; keyHint: string | null; instructions: string; systemPrompt: string }>("/api/accounting/settings/ai");
  const [v, setV] = useState<{ enabled: boolean; model: string; instructions: string; apiKey: string } | null>(null);
  const [showPrompt, setShowPrompt] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (data && !v) setV({ enabled: data.enabled, model: data.model, instructions: data.instructions, apiKey: "" }); }, [data, v]);
  if (!v || !data) return <Skeleton className="h-40" />;
  const save = async (removeKey = false) => {
    setBusy(true); setErr(null); setErrs({});
    try {
      const sendKey = removeKey || !!v.apiKey;
      if (sendKey && !(await ensure())) return;
      await api("/api/accounting/settings/ai", { method: "PATCH", json: { enabled: removeKey ? false : v.enabled, model: v.model, instructions: v.instructions || null, ...(removeKey ? { apiKey: null } : v.apiKey ? { apiKey: v.apiKey } : {}) } });
      setV({ ...v, apiKey: "", enabled: removeKey ? false : v.enabled }); toast("ok", t("saved")); await reload();
    } catch (e) {
      setErr(errMsg(e));
      if (e instanceof ApiError && Array.isArray(e.details)) setErrs(Object.fromEntries((e.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message])));
    } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title={t("title")} description={t("desc")} />
      <div className="space-y-4 p-5">
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" disabled={!admin} checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /><span><span className="font-medium">{t("enable")}</span><span className="block text-xs text-muted">{t("enableHelp")}</span></span></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("apiKey")} error={errs.apiKey} hint={data.hasKey ? t("keySet", { hint: data.keyHint ?? "" }) : t("keyHint")}>{(p) => <Input {...p} type="password" autoComplete="off" disabled={!admin} placeholder={data.hasKey ? "••••••••" : "sk-…"} value={v.apiKey} onChange={(e) => setV({ ...v, apiKey: e.target.value })} />}</Field>
          <Field label={t("model")} error={errs.model} hint={t("modelHint")}>{(p) => <Input {...p} disabled={!admin} value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })} className="font-mono" />}</Field>
        </div>
        <Field label={t("instructions")} hint={t("instructionsHint")}>{(p) => <Textarea {...p} disabled={!admin} value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} className="min-h-24" placeholder={t("instructionsPh")} />}</Field>
        <div><Button size="sm" variant="ghost" onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? t("hidePrompt") : t("showPrompt")}</Button>
          {showPrompt && <pre className="scroll-thin mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs">{data.systemPrompt}</pre>}</div>
        <p className="text-xs text-muted">{t("privacy")}</p>
        {err && <Callout tone="warn">{err}</Callout>}
        {admin && <div className="flex flex-wrap justify-end gap-2">{data.hasKey && <Button variant="ghost" loading={busy} onClick={() => save(true)}>{t("removeKey")}</Button>}<Button variant="primary" loading={busy} onClick={() => save()}>{t("save")}</Button></div>}
      </div>
    </Card>
  );
}
