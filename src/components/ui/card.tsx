import { cn } from "./cn";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) { return <div {...p} className={cn("rounded-card border border-line bg-surface shadow-card", className)} />; }
export function CardHeader({ title, description, action }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4"><div className="min-w-0"><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>{action}</div>;
}
export function Stat({ label, value, hint, icon }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <Card className="rise p-5">
      <div className="flex items-center justify-between text-sm text-muted"><span>{label}</span>{icon}</div>
      <div className="num mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}
export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}</div><div className="flex flex-wrap items-center gap-2">{actions}</div></div>;
}
