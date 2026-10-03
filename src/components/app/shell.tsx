"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bell, Building2, Landmark, Check, ChevronsUpDown, Code2, FileText, LayoutDashboard, LayoutTemplate, Languages, LogOut, Menu, Monitor, Moon, Plus, ScrollText, Search, Settings, ShieldCheck, Sun, Users, Wallet, X } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Dropdown } from "@/components/ui/dropdown";
import { LinkButton } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { cn } from "@/components/ui/cn";
import { api } from "@/lib/api";
import { ElevationProvider } from "./elevate";
import { MeProvider, useMe } from "./me";

const NAV = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard, perm: "contracts.view" },
  { href: "/contracts", key: "contracts", icon: FileText, perm: "contracts.view" },
  { href: "/templates", key: "templates", icon: LayoutTemplate, perm: "templates.view" },
  { href: "/notifications", key: "notifications", icon: Bell, perm: null },
  { href: "/accounting", key: "finance", icon: Landmark, perm: "accounting.view", feature: "accounting" },
  { href: "/my-finances", key: "myFinances", icon: Wallet, perm: null, feature: "organiserPortal" },
  { href: "/audit", key: "audit", icon: ScrollText, perm: "contracts.audit" },
  { href: "/members", key: "members", icon: Users, perm: "users.manage" },
  { href: "/developers", key: "developers", icon: Code2, perm: "webhooks.manage" },
  { href: "/settings", key: "settings", icon: Settings, perm: "settings.manage" },
] as const;

const setCookie = (k: string, v: string) => { document.cookie = `${k}=${v}; path=/; max-age=31536000; samesite=lax`; };

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("app.nav");
  const path = usePathname();
  const { me, can } = useMe();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let dead = false;
    const load = () => api<{ unread: number }>("/api/notifications?unread=1").then((r) => !dead && setUnread(r.unread)).catch(() => {});
    void load(); const i = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(i); };
  }, [path]);
  return (
    // The sidebar is always dark (palette colours 12/13) so the supplied logo, which has light lettering, reads in both themes.
    <div className="flex h-full flex-col bg-[var(--color-12)] text-[var(--color-1)]">
      <div className="px-5 pb-4 pt-5"><Link href="/dashboard" onClick={onNavigate} aria-label="Bilit.event E-Sign"><Logo height={34} /></Link></div>
      <div className="px-3"><LinkButton href="/contracts/new" variant="primary" className="w-full" onClick={onNavigate}><Plus className="size-4" aria-hidden />{t("newContract")}</LinkButton></div>
      <nav aria-label={t("menu")} className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV.filter((n) => (!n.perm || can(n.perm)) && (!("feature" in n) || me.features?.[n.feature])).map((n) => {
          const active = path === n.href || path.startsWith(`${n.href}/`);
          const Icon = n.icon;
          return (
            <Link key={n.href} href={n.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
              className={cn("relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition", active ? "bg-[var(--color-13)] font-medium text-[var(--color-6)]" : "text-[var(--color-2)] hover:bg-[var(--color-10)] hover:text-[var(--color-1)]")}>
              {active && <span aria-hidden className="absolute inset-y-2 start-0 w-[3px] rounded-full bg-[var(--color-5)]" />}
              <Icon className="size-[18px]" aria-hidden />{t(n.key)}
              {n.key === "notifications" && unread > 0 && <span className="num ms-auto rounded-full bg-[var(--color-5)] px-1.5 text-xs font-semibold text-[var(--color-4)]" aria-label={`${unread}`}>{unread > 99 ? "99+" : unread}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-[var(--color-13)] p-3"><OrgSwitcher /></div>
      <span className="sr-only">{me.branding.orgName}</span>
    </div>
  );
}

function OrgSwitcher() {
  const t = useTranslations("app.nav");
  const { me } = useMe();
  const active = me.organisations.find((o) => o.id === me.activeOrganisationId);
  const items = me.organisations.map((o) => ({ label: o.name, icon: o.id === me.activeOrganisationId ? <Check className="size-4" /> : <Building2 className="size-4" />, onSelect: async () => { if (o.id !== me.activeOrganisationId) { await api("/api/auth/switch-org", { json: { organisationId: o.id } }); window.location.href = "/dashboard"; } } }));
  return (
    <Dropdown label={t("switchOrg")} align="start" items={items} trigger={
      <span className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-start hover:bg-[var(--color-10)]">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-13)]"><Building2 className="size-[18px]" aria-hidden /></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{active?.name ?? me.branding.orgName}</span><span className="block truncate text-xs text-[var(--color-2)]">{t("org")}</span></span>
        {me.organisations.length > 1 && <ChevronsUpDown className="size-4 text-[var(--color-2)]" aria-hidden />}
      </span>} />
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const t = useTranslations("app");
  const c = useTranslations("common");
  const a = useTranslations("auth");
  const router = useRouter();
  const locale = useLocale();
  const { me } = useMe();
  const [q, setQ] = useState("");
  const theme = (typeof document !== "undefined" && document.documentElement.dataset.theme) || "system";
  const applyTheme = (v: "light" | "dark" | "system") => { setCookie("theme", v); if (v === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", v); router.refresh(); };
  const lang = (l: string) => { setCookie("locale", l); window.location.reload(); };
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur no-print sm:px-6">
      <button type="button" onClick={onMenu} aria-label={t("nav.menu")} className="grid size-10 place-items-center rounded-xl hover:bg-surface-2 lg:hidden"><Menu className="size-5" /></button>
      <form role="search" onSubmit={(e) => { e.preventDefault(); router.push(`/contracts?q=${encodeURIComponent(q)}`); }} className="relative max-w-md flex-1">
        <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("nav.search")} placeholder={t("nav.search")} className="h-10 w-full rounded-xl border border-line bg-surface ps-10 pe-3 text-sm placeholder:text-muted focus:border-fg" />
      </form>
      <div className="ms-auto flex items-center gap-1">
        <Dropdown label={c("language.label")} items={[{ label: c("language.en"), icon: locale === "en" ? <Check className="size-4" /> : <span className="size-4" />, onSelect: () => lang("en") }, { label: c("language.fa"), icon: locale === "fa" ? <Check className="size-4" /> : <span className="size-4" />, onSelect: () => lang("fa") }]}
          trigger={<span className="grid size-10 place-items-center rounded-xl hover:bg-surface-2"><Languages className="size-[18px]" /></span>} />
        <Dropdown label={c("theme.label")} items={(["light", "dark", "system"] as const).map((v) => ({ label: c(`theme.${v}`), icon: v === "light" ? <Sun className="size-4" /> : v === "dark" ? <Moon className="size-4" /> : <Monitor className="size-4" />, onSelect: () => applyTheme(v) }))}
          trigger={<span className="grid size-10 place-items-center rounded-xl hover:bg-surface-2">{theme === "dark" ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}</span>} />
        <Link href="/notifications" aria-label={t("nav.notifications")} className="grid size-10 place-items-center rounded-xl hover:bg-surface-2"><Bell className="size-[18px]" /></Link>
        <Dropdown label={t("nav.account")} items={[
          { label: t("nav.account"), icon: <ShieldCheck className="size-4" />, href: "/account" },
          { label: a("signOut"), icon: <LogOut className="size-4" />, separatorBefore: true, onSelect: async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); window.location.href = "/login"; } },
        ]} trigger={<span className="flex items-center gap-2.5 rounded-xl py-1 ps-1 pe-2 hover:bg-surface-2"><span className="grid size-8 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-fg">{me.user.name.slice(0, 1).toUpperCase()}</span><span className="hidden max-w-32 truncate text-sm sm:block">{me.user.name}</span></span>} />
      </div>
    </header>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const path = usePathname();
  const t = useTranslations("common");
  useEffect(() => setDrawer(false), [path]);
  // The prepare editor needs the full width for the page canvas.
  const wide = /\/contracts\/[^/]+\/prepare$/.test(path) || /\/templates\/[^/]+$/.test(path) || path.startsWith("/accounting") || path.startsWith("/my-finances");
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-fg focus:px-3 focus:py-2 focus:text-bg">{t("skip")}</a>
      <aside className="sticky top-0 hidden h-dvh lg:block no-print"><Sidebar /></aside>
      {drawer && <div className="fixed inset-0 z-50 lg:hidden"><button aria-label={t("close")} className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-3)_60%,transparent)]" onClick={() => setDrawer(false)} /><div className="pop absolute inset-y-0 start-0 w-72 max-w-[85%]"><Sidebar onNavigate={() => setDrawer(false)} /><button aria-label={t("close")} onClick={() => setDrawer(false)} className="absolute end-2 top-3 grid size-9 place-items-center rounded-lg text-[var(--color-1)]"><X className="size-5" /></button></div></div>}
      <div className="min-w-0"><Topbar onMenu={() => setDrawer(true)} /><main id="main" className={cn("mx-auto w-full px-4 py-6 sm:px-6 sm:py-8", wide ? "max-w-none" : "max-w-7xl")}>{children}</main></div>
    </div>
  );
}

const Loading = () => <div className="grid min-h-dvh place-items-center bg-bg"><div className="w-64 space-y-3"><Skeleton className="h-10" /><Skeleton /><Skeleton className="w-2/3" /></div></div>;

export function AppShell({ children }: { children: React.ReactNode }) {
  return <MeProvider fallback={<Loading />}><ElevationProvider><Frame>{children}</Frame></ElevationProvider></MeProvider>;
}
