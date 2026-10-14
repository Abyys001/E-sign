import { ArrowLeftRight, Banknote, BookOpen, Bot, CalendarDays, CheckCircle2, CreditCard, FileBarChart, HandCoins, Landmark, LayoutDashboard, Library, Scale, Send, Settings, TrendingUp, Undo2, Users, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; key: string; icon: LucideIcon; exact?: true; perm?: "accounting.admin" | "accounting.manage" };
/** Finance sections grouped the way accountants look for them. Routes are unchanged; only presentation is grouped. */
export const NAV_GROUPS: ReadonlyArray<{ key: string; items: ReadonlyArray<NavItem> }> = [
  { key: "overview", items: [
    { href: "/accounting", key: "dashboard", icon: LayoutDashboard, exact: true },
    { href: "/accounting/position", key: "position", icon: Scale },
    { href: "/accounting/overview", key: "overview", icon: TrendingUp },
    { href: "/accounting/reports", key: "reports", icon: FileBarChart },
    { href: "/accounting/ai", key: "ai", icon: Bot },
  ] },
  { key: "transactions", items: [
    { href: "/accounting/transactions", key: "transactions", icon: ArrowLeftRight },
    { href: "/accounting/refunds", key: "refunds", icon: Undo2 },
    { href: "/accounting/reconciliation", key: "reconciliation", icon: CheckCircle2 },
  ] },
  { key: "events", items: [{ href: "/accounting/events", key: "events", icon: CalendarDays }] },
  { key: "organisers", items: [
    { href: "/accounting/organisers", key: "organisers", icon: Users },
    { href: "/accounting/payments", key: "payments", icon: Banknote },
    { href: "/accounting/payouts", key: "payouts", icon: Send },
  ] },
  { key: "accounting", items: [
    { href: "/accounting/books", key: "books", icon: BookOpen },
    { href: "/accounting/profit-share", key: "profitShare", icon: HandCoins },
    { href: "/accounting/ledger", key: "ledger", icon: Library },
  ] },
  { key: "integrations", items: [
    { href: "/accounting/stripe", key: "stripe", icon: CreditCard },
    { href: "/accounting/wise", key: "wise", icon: Landmark },
    { href: "/accounting/settings", key: "settings", icon: Settings, perm: "accounting.admin" },
  ] },
];
export const NAV: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((g) => g.items);
export const isActive = (x: NavItem, path: string) => (x.exact ? path === x.href : path === x.href || path.startsWith(`${x.href}/`));
