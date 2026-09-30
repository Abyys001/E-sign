"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Activity, ShieldAlert } from "lucide-react";
import { Callout, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Card, Stat } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { fmtDate, fmtNum, useApi } from "@/lib/api";

type Page<T> = { total: number; page: number; pageSize: number; items: T[] };
type Summary = { invitations: number; totalOpens: number; uniqueSessions: number; uniqueDevices: number; uniqueIps: number; firstOpenedAt: string | null; lastOpenedAt: string | null; currentlyActive: boolean; started: number; draftSaved: number; submitted: number };
type Sess = { id: string; firstSeenAt: string; lastSeenAt: string; visits: number; active: boolean; activeSeconds: number; device: string; ip: string | null };
type Dev = { firstSeen: string; lastSeen: string; browser: string | null; os: string | null; deviceType: string | null; screen: string | null; ipCount: number; sessionCount: number };
type Ev = { id: number; at: string; label: string; ip: string | null; browser: string | null; os: string | null; deviceType: string | null };
const PAGE = 20;

function usePaged<T>(base: string, extra: string) {
  const [page, setPage] = useState(1);
  const r = useApi<Page<T>>(`${base}?page=${page}&pageSize=${PAGE}${extra}`);
  return { ...r, page, setPage };
}

/** Form-level access analytics. Telemetry is kept separate from the answers and IP/device detail is gated by permission on the server. */
export function FormAccess({ formId }: { formId: string }) {
  const t = useTranslations("intake.access");
  const locale = useLocale();
  const [tab, setTab] = useState<"overview" | "sessions" | "devices" | "events">("overview");
  const [device, setDevice] = useState("");
  const sum = useApi<Summary>(`/api/intake-forms/${formId}/access`);
  const ses = usePaged<Sess>(`/api/intake-forms/${formId}/sessions`, device ? `&deviceType=${device}` : "");
  const dev = usePaged<Dev>(`/api/intake-forms/${formId}/devices`, "");
  const ev = usePaged<Ev>(`/api/intake-forms/${formId}/access-events`, device ? `&deviceType=${device}` : "");
  const secs = (n: number) => (n < 60 ? `${n}s` : `${Math.round(n / 60)}m`);
  const tabs = [{ id: "overview" as const, label: t("overview") }, { id: "sessions" as const, label: t("sessions") }, { id: "devices" as const, label: t("devices") }, { id: "events" as const, label: t("events") }];
  return (
    <div className="space-y-4">
      <Callout tone="info" icon={<ShieldAlert className="size-4" />}>{t("privacy")}</Callout>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("label")} />
      {tab === "overview" && (!sum.data ? <Skeleton className="h-24" /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t("stats.invitations")} value={fmtNum(sum.data.invitations, locale)} />
          <Stat label={t("stats.opens")} value={fmtNum(sum.data.totalOpens, locale)} hint={sum.data.lastOpenedAt ? t("last", { at: fmtDate(sum.data.lastOpenedAt, locale) }) : undefined} />
          <Stat label={t("stats.sessions")} value={fmtNum(sum.data.uniqueSessions, locale)} hint={sum.data.currentlyActive ? t("activeNow") : undefined} />
          <Stat label={t("stats.devices")} value={fmtNum(sum.data.uniqueDevices, locale)} />
          <Stat label={t("stats.started")} value={fmtNum(sum.data.started, locale)} />
          <Stat label={t("stats.saved")} value={fmtNum(sum.data.draftSaved, locale)} />
          <Stat label={t("stats.submitted")} value={fmtNum(sum.data.submitted, locale)} />
          <Stat label={t("stats.ips")} value={fmtNum(sum.data.uniqueIps, locale)} />
        </div>))}
      {tab !== "overview" && tab !== "devices" && (
        <div className="w-48"><Select aria-label={t("deviceType")} value={device} onChange={(e) => { setDevice(e.target.value); ses.setPage(1); ev.setPage(1); }}><option value="">{t("allDevices")}</option>{["desktop", "mobile", "tablet"].map((d) => <option key={d} value={d}>{d}</option>)}</Select></div>)}
      {tab === "sessions" && <Card>{!ses.data ? <Skeleton className="m-4 h-24" /> : !ses.data.items.length ? <EmptyState icon={<Activity className="size-6" />} title={t("none")} /> : <><TableWrap><Table><thead><tr><Th>{t("cols.device")}</Th><Th>{t("cols.ip")}</Th><Th>{t("cols.first")}</Th><Th>{t("cols.last")}</Th><Th>{t("cols.visits")}</Th><Th>{t("cols.active")}</Th></tr></thead><tbody>{ses.data.items.map((s) => <Tr key={s.id}><Td>{s.device}{s.active && <span className="ms-2 rounded-full bg-ok/15 px-2 py-0.5 text-xs">{t("activeNow")}</span>}</Td><Td className="num text-muted">{s.ip ?? "—"}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(s.firstSeenAt, locale)}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(s.lastSeenAt, locale)}</Td><Td className="num">{s.visits}</Td><Td className="num text-muted">≈ {secs(s.activeSeconds)}</Td></Tr>)}</tbody></Table></TableWrap><Pagination page={ses.page} pageSize={PAGE} total={ses.data.total} onPage={ses.setPage} /></>}</Card>}
      {tab === "devices" && <Card>{!dev.data ? <Skeleton className="m-4 h-24" /> : !dev.data.items.length ? <EmptyState icon={<Activity className="size-6" />} title={t("none")} /> : <><TableWrap><Table><thead><tr><Th>{t("cols.browser")}</Th><Th>{t("cols.os")}</Th><Th>{t("cols.type")}</Th><Th>{t("cols.screen")}</Th><Th>{t("cols.sessions")}</Th><Th>{t("cols.last")}</Th></tr></thead><tbody>{dev.data.items.map((d, i) => <Tr key={i}><Td>{d.browser ?? "—"}</Td><Td>{d.os ?? "—"}</Td><Td>{d.deviceType ?? "—"}</Td><Td className="num text-muted">{d.screen ?? "—"}</Td><Td className="num">{d.sessionCount}</Td><Td className="whitespace-nowrap text-muted">{fmtDate(d.lastSeen, locale)}</Td></Tr>)}</tbody></Table></TableWrap><Pagination page={dev.page} pageSize={PAGE} total={dev.data.total} onPage={dev.setPage} /></>}</Card>}
      {tab === "events" && <Card>{!ev.data ? <Skeleton className="m-4 h-24" /> : !ev.data.items.length ? <EmptyState icon={<Activity className="size-6" />} title={t("none")} /> : <><TableWrap><Table><thead><tr><Th>{t("cols.at")}</Th><Th>{t("cols.event")}</Th><Th>{t("cols.device")}</Th><Th>{t("cols.ip")}</Th></tr></thead><tbody>{ev.data.items.map((e) => <Tr key={e.id}><Td className="whitespace-nowrap text-muted">{fmtDate(e.at, locale)}</Td><Td>{e.label}</Td><Td className="text-muted">{[e.browser, e.os].filter(Boolean).join(" · ") || "—"}</Td><Td className="num text-muted">{e.ip ?? "—"}</Td></Tr>)}</tbody></Table></TableWrap><Pagination page={ev.page} pageSize={PAGE} total={ev.data.total} onPage={ev.setPage} /></>}</Card>}
    </div>
  );
}
