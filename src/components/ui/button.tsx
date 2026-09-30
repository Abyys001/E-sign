"use client";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

const base = "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition active:scale-[.98] disabled:pointer-events-none disabled:opacity-50";
const variants = {
  primary: "bg-accent text-accent-fg shadow-sm hover:brightness-95",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  ghost: "text-fg hover:bg-surface-2",
  // No red in the palette: destructive actions are the inverted (max-contrast) button plus an explicit label and confirmation.
  danger: "bg-fg text-bg hover:opacity-90",
} as const;
const sizes = { sm: "h-8 px-3", md: "h-10 px-4", lg: "h-12 px-6 text-base", icon: "h-9 w-9" } as const;

type Common = { variant?: keyof typeof variants; size?: keyof typeof sizes; loading?: boolean; className?: string };
export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...p }: Common & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...p} disabled={disabled || loading} aria-busy={loading || undefined} className={cn(base, variants[variant], sizes[size], className)}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
export function LinkButton({ variant = "secondary", size = "md", className, ...p }: Common & React.ComponentProps<typeof Link>) {
  return <Link {...p} className={cn(base, variants[variant], sizes[size], className)} />;
}
