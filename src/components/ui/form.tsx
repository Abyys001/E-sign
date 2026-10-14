"use client";
import { useId } from "react";
import { cn } from "./cn";

const control = "w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-fg placeholder:text-muted transition focus:border-fg disabled:opacity-60 aria-[invalid=true]:border-2 aria-[invalid=true]:border-fg";

/** Label + control + hint/error wiring so every input is programmatically labelled and its error is announced. */
export function Field({ label, hint, error, required, children }: { label: string; hint?: string; error?: string | null; required?: boolean; children: (p: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode }) {
  const id = useId();
  const desc = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">{label}{required && <span aria-hidden className="ms-0.5 text-muted">*</span>}</label>
      {children({ id, "aria-describedby": desc, "aria-invalid": error ? true : undefined })}
      {error ? <p id={`${id}-e`} role="alert" className="text-xs font-medium">⚠ {error}</p> : hint ? <p id={`${id}-h`} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
export function Input({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={cn(control, "h-10", className)} />; }
export function Textarea({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={cn(control, "min-h-24 py-2.5", className)} />; }
/** `control` is full width; an explicit width class on the element wins (cn does not merge conflicting utilities). */
const sized = (className?: string) => (className && /(^|\s)(w-|min-w-|max-w-)/.test(className) && !/(^|\s)w-full\b/.test(className) ? control.replace("w-full ", "") : control);
export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...p} className={cn(sized(className), "h-10 pe-8", className)}>{children}</select>; }

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full border transition disabled:opacity-50", checked ? "border-accent bg-accent" : "border-line-strong bg-surface-2")}>
      <span className={cn("absolute top-0.5 size-4.5 rounded-full bg-surface shadow transition-all", checked ? "start-[22px] bg-accent-fg" : "start-0.5 bg-fg")} />
    </button>
  );
}
export function SwitchField(p: React.ComponentProps<typeof Switch>) {
  return <div className="flex items-center justify-between gap-3 text-sm"><span>{p.label}</span><Switch {...p} /></div>;
}
export function Checkbox({ label, className, ...p }: { label: React.ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className={cn("flex cursor-pointer items-start gap-2.5 text-sm", className)}><input type="checkbox" {...p} className="mt-0.5 size-4 shrink-0 accent-[var(--color-5)]" /><span>{label}</span></label>;
}
