import { cn } from "./cn";

export const TableWrap = ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={cn("scroll-thin overflow-x-auto", className)}>{children}</div>;
export const Table = ({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) => <table {...p} className={cn("w-full text-start text-sm", className)} />;
// Default alignment only when the caller gives none: cn() does not dedupe classes, and in the generated CSS `text-start` would beat `text-end`.
export const Th = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th {...p} scope="col" className={cn("whitespace-nowrap border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted first:rounded-ss-xl last:rounded-se-xl", !/\btext-(end|center|right|left)\b/.test(className ?? "") && "text-start", className)} />;
export const Td = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cn("border-b border-line px-4 py-3 align-middle", className)} />;
export const Tr = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...p} className={cn("transition-colors hover:bg-surface-2/70", className)} />;
