import { cn } from "./cn";

/** The supplied animated GIF, unmodified. Reduced-motion users get the static frame (a separate export of the same artwork). */
export function Logo({ className, height = 36 }: { className?: string; height?: number }) {
  return (
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcSet="/brand/bilit-esign-logo-static.png" />
      <img src="/brand/bilit-esign-logo.gif" alt="Bilit.event E-Sign" width={height * 4} height={height} className={cn("block w-auto", className)} style={{ height }} />
    </picture>
  );
}
