import { useTranslations } from "next-intl";
import { cn } from "./cn";
import { Inbox } from "lucide-react";

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn("skeleton h-4 w-full", className)} />;

export function EmptyState({ icon, title, description, action }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft text-fg">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export function Callout({ tone = "info", title, children, icon }: { tone?: "info" | "warn" | "ok"; title?: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  // Tone is carried by icon + border weight, never by an off-palette colour.
  return (
    <div role={tone === "warn" ? "alert" : "status"} className={cn("flex gap-3 rounded-xl border p-3.5 text-sm", tone === "warn" ? "border-2 border-fg bg-surface" : tone === "ok" ? "border-accent bg-accent-soft" : "border-line-strong bg-surface-2")}>
      {icon}<div className="min-w-0">{title && <p className="font-medium">{title}</p>}{children && <div className={cn(title && "mt-0.5 text-muted")}>{children}</div>}</div>
    </div>
  );
}
export function Spinner({ className }: { className?: string }) {
  const t = useTranslations("common");
  return <span role="status" aria-label={t("a11y.loading")} className={cn("inline-block size-5 animate-spin rounded-full border-2 border-line-strong border-t-fg", className)} />;
}
