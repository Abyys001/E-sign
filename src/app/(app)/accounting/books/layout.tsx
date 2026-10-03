"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { faChartPie, faFileInvoiceDollar, faMoneyCheckDollar, faUsers } from "@fortawesome/free-solid-svg-icons";
import { useMe } from "@/components/app/me";
import { Fa } from "@/components/accounting/books";
import { cn } from "@/components/ui/cn";

/** Bookkeeping section: overview, supplier invoices & expenses, employees and payslips (payroll needs its own permission). */
export default function BooksLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("accounting.books.nav");
  const path = usePathname();
  const { can } = useMe();
  const items = [
    { href: "/accounting/books", label: t("overview"), icon: faChartPie, exact: true },
    { href: "/accounting/books/invoices", label: t("invoices"), icon: faFileInvoiceDollar },
    ...(can("accounting.payroll") ? [{ href: "/accounting/books/employees", label: t("employees"), icon: faUsers }, { href: "/accounting/books/payslips", label: t("payslips"), icon: faMoneyCheckDollar }] : []),
  ];
  return (
    <div>
      <nav aria-label={t("label")} className="mb-5 flex flex-wrap gap-1.5">
        {items.map((i) => { const on = i.exact ? path === i.href : path.startsWith(i.href); return (
          <Link key={i.href} href={i.href} aria-current={on ? "page" : undefined} className={cn("inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition", on ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg")}>
            <Fa icon={i.icon} className="text-xs" />{i.label}</Link>); })}
      </nav>
      {children}
    </div>
  );
}
