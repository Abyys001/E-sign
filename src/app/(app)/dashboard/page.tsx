"use client";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Clock3, FileEdit, FileText, PenLine, Timer, XCircle } from "lucide-react";
import { useMe } from "@/components/app/me";
import { Card, CardHeader, PageHeader, Stat } from "@/components/ui/card";
import { TrendChart } from "@/components/ui/chart";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { StatusBadge } from "@/components/ui/status";
import { fmtDate, fmtNum, useApi } from "@/lib/api";
import { ek } from "@/lib/i18n-key";

type Dash = {
  totals: { all: number; draft: number; sent: number; awaiting: number; completed: number; declined: number; expired: number; cancelled: number; archived: number };
  signaturesCompleted: number; avgCompletionHours: number | null; trend: Array<{ day: string; sent: number; completed: number }>;
  email: Record<string, number>; sms: Record<string, number>; remindersLast7d: number;
  recent: Array<{ eventType: string; occurredAt: string; contractId: string; contractName: string; reference: string }>;
  attention: Array<{ id: string; name: string; reference: string; status: string; expiresAt: string | null }>;
};

export default function DashboardPage() {
  const t = useTranslations("app.dashboard");
  const te = useTranslations("app.events");
  const locale = useLocale();
  const { me } = useMe();
  const { data, loading, error } = useApi<Dash>("/api/dashboard");
  const n = (v: number) => fmtNum(v, locale);
  if (loading && !data) return <div className="space-y-6"><Skeleton className="h-10 w-72" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32" />)}</div><Skeleton className="h-64" /></div>;
  if (error || !data) return <EmptyState title={t("title")} description={error?.message} />;
  const s = data.totals;
  return (
    <div>
      <PageHeader title={t("hello", { name: me.user.name.split(" ")[0] ?? "" })} description={t("sub")} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t("stats.awaiting")} value={n(s.awaiting)} icon={<Clock3 className="size-4" />} />
        <Stat label={t("stats.completed")} value={n(s.completed)} icon={<CheckCircle2 className="size-4" />} hint={`${t("stats.signatures")}: ${n(data.signaturesCompleted)}`} />
        <Stat label={t("stats.drafts")} value={n(s.draft)} icon={<FileEdit className="size-4" />} />
        <Stat label={t("stats.avg")} value={data.avgCompletionHours === null ? "—" : t("hours", { n: n(data.avgCompletionHours) })} icon={<Timer className="size-4" />} hint={data.avgCompletionHours === null ? t("noAvg") : undefined} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Stat label={t("stats.declined")} value={n(s.declined)} icon={<XCircle className="size-4" />} />
        <Stat label={t("stats.expired")} value={n(s.expired)} icon={<AlertTriangle className="size-4" />} />
        <Stat label={t("stats.all")} value={n(s.all)} icon={<FileText className="size-4" />} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title={t("trend")} /><div className="p-5"><TrendChart data={data.trend.map((d) => ({ label: d.day, a: d.sent, b: d.completed }))} aLabel={t("sent")} bLabel={t("completedSeries")} caption={t("trend")} /></div></Card>
        <Card>
          <CardHeader title={t("attention")} />
          {data.attention.length === 0 ? <EmptyState icon={<CheckCircle2 className="size-6" />} title={t("attentionEmpty")} /> : (
            <ul className="divide-y divide-line">{data.attention.map((c) => (
              <li key={c.id}><Link href={`/contracts/${c.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2"><span className="min-w-0"><span className="block truncate text-sm font-medium">{c.name}</span><span className="block text-xs text-muted">{c.status === "DECLINED" ? t("declinedRecently") : t("expiresIn", { date: fmtDate(c.expiresAt, locale, { dateStyle: "medium" }) })}</span></span><StatusBadge status={c.status} /></Link></li>
            ))}</ul>
          )}
        </Card>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t("recent")} />
          {data.recent.length === 0 ? <EmptyState icon={<PenLine className="size-6" />} title={t("recentEmpty")} /> : (
            <ul className="divide-y divide-line">{data.recent.map((r, i) => (
              <li key={i}><Link href={`/contracts/${r.contractId}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-surface-2"><span className="min-w-0 truncate"><span className="font-medium">{r.contractName}</span> <span className="text-muted">{te.has(ek(r.eventType) as never) ? te(ek(r.eventType) as never) : r.eventType}</span></span><time className="shrink-0 text-xs text-muted" dateTime={r.occurredAt}>{fmtDate(r.occurredAt, locale)}</time></Link></li>
            ))}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title={t("delivery")} />
          <div className="space-y-5 p-5 text-sm">
            <Breakdown title={t("emails")} rows={data.email} label={(k) => t(`emailStatus.${k}`)} empty={t("noMessages")} n={n} />
            <Breakdown title={t("sms")} rows={data.sms} label={(k) => t(`smsStatus.${k}`)} empty={t("noMessages")} n={n} />
            <div className="flex justify-between border-t border-line pt-4"><span className="text-muted">{t("reminders")}</span><span className="num font-medium">{n(data.remindersLast7d)}</span></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Breakdown({ title, rows, label, empty, n }: { title: string; rows: Record<string, number>; label: (k: string) => string; empty: string; n: (v: number) => string }) {
  const entries = Object.entries(rows);
  return (
    <div><h3 className="mb-2 font-medium">{title}</h3>
      {entries.length === 0 ? <p className="text-muted">{empty}</p> : <ul className="space-y-1.5">{entries.map(([k, v]) => <li key={k} className="flex justify-between"><span className="text-muted">{label(k)}</span><span className="num">{n(v)}</span></li>)}</ul>}
    </div>
  );
}
