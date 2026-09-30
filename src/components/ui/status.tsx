import { useTranslations } from "next-intl";
import { Archive, Ban, CheckCircle2, Clock, Eye, FileEdit, Hourglass, PenLine, Send, ShieldOff, Timer, XCircle, MailCheck, type LucideIcon } from "lucide-react";
import { cn } from "./cn";

// Palette has no red/amber, so each status has its own icon + label, and weight/border style separates "done", "active" and "stopped".
const CONTRACT: Record<string, { icon: LucideIcon; tone: "done" | "active" | "idle" | "stopped" }> = {
  DRAFT: { icon: FileEdit, tone: "idle" }, READY_TO_SEND: { icon: FileEdit, tone: "idle" }, SENT: { icon: Send, tone: "active" }, DELIVERED: { icon: MailCheck, tone: "active" },
  VIEWED: { icon: Eye, tone: "active" }, PARTIALLY_SIGNED: { icon: PenLine, tone: "active" }, AWAITING_SIGNATURE: { icon: Hourglass, tone: "active" },
  COMPLETED: { icon: CheckCircle2, tone: "done" }, DECLINED: { icon: XCircle, tone: "stopped" }, CANCELLED: { icon: Ban, tone: "stopped" }, EXPIRED: { icon: Timer, tone: "stopped" },
  VOIDED: { icon: ShieldOff, tone: "stopped" }, ARCHIVED: { icon: Archive, tone: "idle" },
};
const RECIPIENT: Record<string, { icon: LucideIcon; tone: "done" | "active" | "idle" | "stopped" }> = {
  PENDING: { icon: Clock, tone: "idle" }, SENT: { icon: Send, tone: "active" }, VIEWED: { icon: Eye, tone: "active" }, COMPLETED: { icon: CheckCircle2, tone: "done" }, DECLINED: { icon: XCircle, tone: "stopped" }, REMOVED: { icon: Ban, tone: "stopped" },
};
const tone = { done: "border-accent bg-accent-soft", active: "border-line-strong bg-surface-2", idle: "border-dashed border-line-strong text-muted", stopped: "border-2 border-fg bg-surface font-medium" };

export function StatusBadge({ status, kind = "contract", className }: { status: string; kind?: "contract" | "recipient"; className?: string }) {
  const t = useTranslations("common");
  const m = (kind === "contract" ? CONTRACT : RECIPIENT)[status] ?? { icon: Clock, tone: "idle" as const };
  const Icon = m.icon;
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs", tone[m.tone], className)}><Icon className="size-3.5" aria-hidden />{t(`status.${kind}.${status}`)}</span>;
}

/** Recipient identity marker: number + border style (never colour alone). */
const BORDERS = ["border-solid", "border-dashed", "border-dotted", "border-double"] as const;
export function RecipientDot({ index, name, className }: { index: number; name?: string; className?: string }) {
  return <span title={name} aria-label={name ? `${index + 1}. ${name}` : String(index + 1)} className={cn("num grid size-7 shrink-0 place-items-center rounded-full border-2 border-fg bg-surface text-xs font-semibold", BORDERS[index % 4], className)}>{index + 1}</span>;
}
