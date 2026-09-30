"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMe } from "@/components/app/me";
import { cn } from "@/components/ui/cn";

const TABS = [
  { href: "/templates/agreements", key: "agreements", perm: "templates.view" },
  { href: "/templates/intake", key: "forms", perm: "intake.view" },
  { href: "/templates/clauses", key: "clauses", perm: "templates.view" },
  { href: "/templates/variables", key: "variables", perm: "templates.view" },
  { href: "/templates", key: "pdf", perm: "templates.view" },
  { href: "/settings", key: "email", perm: "settings.manage" },
] as const;

export default function TemplatesHubLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("intake.hub");
  const path = usePathname();
  const { can } = useMe();
  return (
    <div>
      <nav aria-label={t("label")} className="scroll-thin mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.filter((x) => can(x.perm)).map((x) => {
          const active = x.href === "/templates" ? path === "/templates" : path === x.href || path.startsWith(`${x.href}/`);
          return <Link key={x.href} href={x.href} aria-current={active ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm transition", active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>{t(x.key)}</Link>;
        })}
      </nav>
      {children}
    </div>
  );
}
