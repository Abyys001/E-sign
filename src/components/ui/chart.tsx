"use client";
import { useId } from "react";
import { useTranslations } from "next-intl";

type Point = { label: string; a: number; b: number };

/** Two-series bar chart in palette colours; shape (solid vs hatched) distinguishes series, values are exposed in a table for screen readers. */
export function TrendChart({ data, aLabel, bLabel, caption }: { data: Point[]; aLabel: string; bLabel: string; caption: string }) {
  const id = useId();
  const t = useTranslations("common");
  const max = Math.max(1, ...data.flatMap((d) => [d.a, d.b]));
  const W = 720, H = 180, pad = 22, bw = (W - pad * 2) / data.length;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-labelledby={`${id}-t`} className="w-full">
        <title id={`${id}-t`}>{caption}</title>
        <defs><pattern id={`${id}-h`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="none" /><line x1="0" y1="0" x2="0" y2="5" stroke="var(--fg)" strokeWidth="2" /></pattern></defs>
        {[0, .5, 1].map((f) => <line key={f} x1={pad} x2={W - pad} y1={H - f * (H - 8)} y2={H - f * (H - 8)} stroke="var(--line)" strokeDasharray={f === 0 ? undefined : "3 4"} />)}
        {data.map((d, i) => {
          const x = pad + i * bw, ha = (d.a / max) * (H - 8), hb = (d.b / max) * (H - 8);
          return <g key={d.label}>
            <rect x={x + bw * .12} y={H - ha} width={bw * .36} height={ha} rx="2" fill="var(--accent)"><title>{`${d.label} · ${aLabel}: ${d.a}`}</title></rect>
            <rect x={x + bw * .52} y={H - hb} width={bw * .36} height={hb} rx="2" fill={`url(#${id}-h)`} stroke="var(--fg)" strokeWidth=".8"><title>{`${d.label} · ${bLabel}: ${d.b}`}</title></rect>
            {i % 6 === 0 && <text x={x + bw / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="var(--muted)">{d.label.slice(5)}</text>}
          </g>;
        })}
      </svg>
      <figcaption className="mt-2 flex gap-5 text-xs text-muted"><span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm bg-accent" />{aLabel}</span><span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm border border-fg" style={{ background: "repeating-linear-gradient(45deg, var(--fg) 0 1.5px, transparent 1.5px 4px)" }} />{bLabel}</span></figcaption>
      <table className="sr-only"><caption>{caption}</caption><thead><tr><th>{t("a11y.date")}</th><th>{aLabel}</th><th>{bLabel}</th></tr></thead><tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{d.a}</td><td>{d.b}</td></tr>)}</tbody></table>
    </figure>
  );
}
