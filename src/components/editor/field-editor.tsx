"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AtSign, Building2, Calendar, CalendarClock, CheckSquare, ChevronDownSquare, CircleDot, Copy, DollarSign, FileUp, Hash, Layers, PenLine, Phone, Plus, Redo2, Trash2, Type, Undo2, User, WrapText, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Checkbox } from "@/components/ui/form";
import { PdfViewer, type PageDim } from "@/components/ui/pdf-viewer";
import { RecipientDot } from "@/components/ui/status";
import { FIELD_TYPES, acceptsDefault, extraKeys, hasOptions, makeField, newFieldId, type EditorField, type FieldType } from "./model";

export type Party = { id: string; name: string; sub?: string };
const ICON: Record<FieldType, LucideIcon> = { signature: PenLine, initials: Type, text: Type, long_text: WrapText, email: AtSign, phone: Phone, date: Calendar, datetime: CalendarClock, checkbox: CheckSquare, radio: CircleDot, dropdown: ChevronDownSquare, number: Hash, currency: DollarSign, company: Building2, job_title: User, attachment: FileUp };
const BORDER = ["solid", "dashed", "dotted", "double"] as const;
const SNAP = 0.006;

type Props = { pdfUrl: string; parties: Party[]; value: EditorField[]; onChange: (f: EditorField[]) => void; onAddParty?: () => void; partyLabel?: string; readOnly?: boolean; toolbarExtra?: React.ReactNode };

/** Shared field editor for contract preparation and template design. State lives in the parent; this owns interaction only. */
export function FieldEditor({ pdfUrl, parties, value, onChange, onAddParty, partyLabel, readOnly, toolbarExtra }: Props) {
  const t = useTranslations("editor");
  const [active, setActive] = useState(parties[0]?.id ?? "");
  const [armed, setArmed] = useState<FieldType | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dims, setDims] = useState<PageDim[]>([]);
  const past = useRef<EditorField[][]>([]);
  const future = useRef<EditorField[][]>([]);
  const valueRef = useRef(value); valueRef.current = value;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!parties.some((p) => p.id === active)) setActive(parties[0]?.id ?? ""); }, [parties, active]);

  const commit = useCallback((next: EditorField[], record = true) => {
    if (record) { past.current.push(valueRef.current); if (past.current.length > 100) past.current.shift(); future.current = []; }
    onChange(next);
  }, [onChange]);
  const undo = () => { const p = past.current.pop(); if (p) { future.current.push(valueRef.current); onChange(p); } };
  const redo = () => { const n = future.current.pop(); if (n) { past.current.push(valueRef.current); onChange(n); } };
  const upd = (id: string, patch: Partial<EditorField>, record = true) => commit(valueRef.current.map((f) => (f.id === id ? { ...f, ...patch } : f)), record);
  const idx = (pid: string) => Math.max(0, parties.findIndex((p) => p.id === pid));
  const selected = value.find((f) => f.id === sel) ?? null;

  const remove = (id: string) => { commit(valueRef.current.filter((f) => f.id !== id)); setSel(null); };
  const duplicate = (f: EditorField) => { const c = { ...f, id: newFieldId(), x: Math.min(f.x + 0.02, 1 - f.w), y: Math.min(f.y + 0.02, 1 - f.h) }; commit([...valueRef.current, c]); setSel(c.id); };
  const everyPage = (f: EditorField) => { const others = dims.map((_, p) => p).filter((p) => p !== f.page && !valueRef.current.some((x) => x.page === p && x.type === f.type && x.partyId === f.partyId)); commit([...valueRef.current, ...others.map((p) => ({ ...f, id: newFieldId(), page: p }))]); };

  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") { setArmed(null); setSel(null); return; }
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (!sel) return;
      const f = valueRef.current.find((x) => x.id === sel); if (!f) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(f.id); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(f); }
      else if (e.key.startsWith("Arrow")) {
        e.preventDefault(); const s = e.shiftKey ? 0.02 : 0.004;
        upd(f.id, { x: clamp(f.x + (e.key === "ArrowRight" ? s : e.key === "ArrowLeft" ? -s : 0), 0, 1 - f.w), y: clamp(f.y + (e.key === "ArrowDown" ? s : e.key === "ArrowUp" ? -s : 0), 0, 1 - f.h) });
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, readOnly, dims]);

  const place = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
    if (!armed || !active || readOnly) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = makeField(armed, active, page, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    commit([...valueRef.current, f]); setSel(f.id); setArmed(null);
  };

  const startDrag = (e: React.PointerEvent, f: EditorField, mode: "move" | "resize") => {
    if (readOnly) return;
    e.stopPropagation(); e.preventDefault();
    setSel(f.id);
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement; const box = pageEl.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, base = { ...f };
    past.current.push(valueRef.current); future.current = [];
    const others = valueRef.current.filter((o) => o.page === f.page && o.id !== f.id);
    const snap = (v: number, edges: number[]) => { for (const g of edges) if (Math.abs(v - g) < SNAP) return g; return v; };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / box.width, dy = (ev.clientY - sy) / box.height;
      let patch: Partial<EditorField>;
      if (mode === "move") {
        const xs = others.flatMap((o) => [o.x, o.x + o.w]), ys = others.flatMap((o) => [o.y, o.y + o.h]);
        let nx = clamp(base.x + dx, 0, 1 - base.w), ny = clamp(base.y + dy, 0, 1 - base.h);
        nx = snap(nx, xs); nx = snap(nx + base.w, xs) - base.w; ny = snap(ny, ys); ny = snap(ny + base.h, ys) - base.h;
        patch = { x: clamp(nx, 0, 1 - base.w), y: clamp(ny, 0, 1 - base.h) };
      } else patch = { w: clamp(base.w + dx, 0.02, 1 - base.x), h: clamp(base.h + dy, 0.012, 1 - base.y) };
      onChange(valueRef.current.map((x) => (x.id === f.id ? { ...x, ...patch } : x)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const overlay = (page: number) => (
    <div dir="ltr" className={cn("absolute inset-0", armed && "cursor-crosshair")} onPointerDown={(e) => { if (armed) place(e, page); else setSel(null); }}>
      {value.filter((f) => f.page === page).map((f) => {
        const Icon = ICON[f.type]; const i = idx(f.partyId); const on = sel === f.id; const mine = f.partyId === active;
        return (
          <div key={f.id} role="button" tabIndex={0} aria-label={`${t(`types.${f.type}`)} — ${parties[i]?.name ?? ""}`} aria-pressed={on}
            onPointerDown={(e) => startDrag(e, f, "move")} onFocus={() => setSel(f.id)}
            className={cn("group absolute flex touch-none items-center gap-1 overflow-hidden rounded-[3px] border-2 border-fg px-1 text-[11px] leading-none", readOnly ? "cursor-default" : "cursor-move", mine ? "bg-accent-soft" : "bg-surface/60", on && "ring-2 ring-fg ring-offset-1 ring-offset-white")}
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, borderStyle: BORDER[i % 4], color: "var(--color-4)" }}>
            <span className="num grid size-4 shrink-0 place-items-center rounded-full bg-fg text-[10px] font-semibold text-bg">{i + 1}</span>
            <Icon className="size-3 shrink-0" aria-hidden /><span className="truncate">{f.label || t(`types.${f.type}`)}</span>{f.required && <span aria-hidden>*</span>}
            {on && !readOnly && <span onPointerDown={(e) => startDrag(e, f, "resize")} aria-hidden className="absolute bottom-0 end-0 size-3 cursor-nwse-resize rounded-tl-sm bg-fg" style={{ insetInlineEnd: 0 }} />}
          </div>
        );
      })}
    </div>
  );

  const thumbs = useMemo(() => dims.length > 0, [dims]);
  return (
    <div className="grid h-[calc(100dvh-8.5rem)] min-h-[560px] gap-4 lg:grid-cols-[264px_1fr_300px]">
      {/* Left: recipients + palette */}
      <aside className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto rounded-card border border-line bg-surface p-4 shadow-card">
        <section aria-labelledby="ed-rec">
          <div className="mb-2 flex items-center justify-between"><h2 id="ed-rec" className="text-sm font-semibold">{partyLabel ?? t("recipients")}</h2>{onAddParty && !readOnly && <Button size="sm" onClick={onAddParty}><Plus className="size-3.5" aria-hidden />{t("addRecipient")}</Button>}</div>
          {parties.length === 0 ? <p className="text-sm text-muted">{t("noRecipients")}</p> : (
            <ul className="space-y-1.5" role="radiogroup" aria-label={t("active")}>{parties.map((p, i) => (
              <li key={p.id}><button type="button" role="radio" aria-checked={active === p.id} onClick={() => setActive(p.id)} className={cn("flex w-full items-center gap-2.5 rounded-xl border p-2 text-start transition", active === p.id ? "border-2 border-fg bg-accent-soft" : "border-line hover:bg-surface-2")}>
                <RecipientDot index={i} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{p.name}</span>{p.sub && <span className="block truncate text-xs text-muted">{p.sub}</span>}</span>
                <span className="num ms-auto text-xs text-muted">{value.filter((f) => f.partyId === p.id).length}</span></button></li>))}</ul>
          )}
        </section>
        {!readOnly && (
          <section aria-labelledby="ed-pal"><h2 id="ed-pal" className="mb-1 text-sm font-semibold">{t("palette")}</h2><p className="mb-2 text-xs text-muted">{t("paletteHint")}</p>
            <div className="grid grid-cols-2 gap-1.5">{FIELD_TYPES.map((ft) => { const Icon = ICON[ft]; return (
              <button key={ft} type="button" disabled={!active} aria-pressed={armed === ft} onClick={() => setArmed(armed === ft ? null : ft)} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-2 text-start text-xs transition disabled:opacity-40", armed === ft ? "border-2 border-fg bg-accent text-accent-fg" : "border-line hover:bg-surface-2")}><Icon className="size-3.5 shrink-0" aria-hidden />{t(`types.${ft}`)}</button>); })}</div>
            <p className="mt-3 text-xs text-muted">{t("shortcuts")}</p>
          </section>
        )}
      </aside>

      {/* Center: canvas */}
      <section className="flex min-h-0 min-w-0 flex-col rounded-card border border-line bg-surface-2 shadow-card" aria-label={t("title")}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <Button size="icon" aria-label={t("undo")} onClick={undo} disabled={readOnly}><Undo2 className="size-4" /></Button>
          <Button size="icon" aria-label={t("redo")} onClick={redo} disabled={readOnly}><Redo2 className="size-4" /></Button>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button size="icon" aria-label={t("zoomOut")} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}><ZoomOut className="size-4" /></Button>
          <button type="button" onClick={() => setZoom(1)} title={t("fit")} className="num w-14 rounded-lg py-1 text-center text-sm hover:bg-surface-2">{Math.round(zoom * 100)}%</button>
          <Button size="icon" aria-label={t("zoomIn")} onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}><ZoomIn className="size-4" /></Button>
          <div className="ms-auto flex items-center gap-2">{toolbarExtra}</div>
        </div>
        {armed && <div role="status" className="border-b border-line bg-accent-soft px-4 py-2 text-sm">{t("placing", { type: t(`types.${armed}`) })}</div>}
        <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-auto p-4">
          <PdfViewer src={pdfUrl} zoom={zoom} onLoaded={setDims} overlay={overlay} pageProps={(p) => ({ onPointerDown: (e) => { if (armed && (e.target as HTMLElement).closest("[role=button]") === null) place(e, p); }, className: armed ? "cursor-crosshair" : undefined })} />
        </div>
      </section>

      {/* Right: pages + properties */}
      <aside className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto rounded-card border border-line bg-surface p-4 shadow-card">
        <section aria-labelledby="ed-props">
          <h2 id="ed-props" className="mb-3 text-sm font-semibold">{t("props.title")}</h2>
          {!selected ? <p className="text-sm text-muted">{t("props.none")}</p> : <Props f={selected} parties={parties} readOnly={!!readOnly} pageCount={dims.length} onChange={(p) => upd(selected.id, p)} onDelete={() => remove(selected.id)} onDuplicate={() => duplicate(selected)} onEvery={() => everyPage(selected)} />}
        </section>
        {thumbs && (
          <section aria-labelledby="ed-pages" className="border-t border-line pt-4"><h2 id="ed-pages" className="mb-2 flex items-center gap-2 text-sm font-semibold"><Layers className="size-4" aria-hidden />{t("pages")}</h2>
            <div className="max-h-72 overflow-y-auto"><PdfViewer src={pdfUrl} maxWidth={96} className="gap-2" pageProps={(p) => ({ onClick: () => scroller.current?.querySelector(`[data-page="${p}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), className: "cursor-pointer hover:ring-2 hover:ring-fg" })} /></div>
          </section>
        )}
      </aside>
    </div>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

function Props({ f, parties, readOnly, pageCount, onChange, onDelete, onDuplicate, onEvery }: { f: EditorField; parties: Party[]; readOnly: boolean; pageCount: number; onChange: (p: Partial<EditorField>) => void; onDelete: () => void; onDuplicate: () => void; onEvery: () => void }) {
  const t = useTranslations("editor");
  const ex = (k: string, v: unknown) => onChange({ extras: { ...f.extras, [k]: v === "" ? undefined : v } });
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => ex(k, e.target.value === "" ? "" : Number(e.target.value));
  const keys = extraKeys(f.type);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">{t(`types.${f.type}`)} · {t("page", { n: f.page + 1 })}</p>
      <Field label={t("props.label")}>{(p) => <Input {...p} value={f.label} disabled={readOnly} maxLength={200} onChange={(e) => onChange({ label: e.target.value })} />}</Field>
      <Field label={t("props.recipient")}>{(p) => <Select {...p} value={f.partyId} disabled={readOnly} onChange={(e) => onChange({ partyId: e.target.value })}>{parties.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {x.name}</option>)}</Select>}</Field>
      <Checkbox label={t("props.required")} checked={f.required} disabled={readOnly} onChange={(e) => onChange({ required: e.target.checked })} />
      {hasOptions(f.type) && <Field label={t("props.options")}>{(p) => <Textarea {...p} value={f.options.join("\n")} disabled={readOnly} onChange={(e) => onChange({ options: e.target.value.split("\n") })} />}</Field>}
      {keys.includes("maxLength") && <Field label={t("props.maxLength")}>{(p) => <Input {...p} type="number" min={1} value={String(f.extras.maxLength ?? "")} disabled={readOnly} onChange={num("maxLength")} />}</Field>}
      {keys.includes("pattern") && <Field label={t("props.pattern")}>{(p) => <Input {...p} dir="ltr" value={String(f.extras.pattern ?? "")} disabled={readOnly} onChange={(e) => ex("pattern", e.target.value)} />}</Field>}
      {keys.includes("currency") && <Field label={t("props.currency")}>{(p) => <Input {...p} dir="ltr" maxLength={3} value={String(f.extras.currency ?? "")} disabled={readOnly} onChange={(e) => ex("currency", e.target.value.toUpperCase())} />}</Field>}
      {f.type === "date" ? <div className="grid grid-cols-2 gap-2"><Field label={t("props.min")}>{(p) => <Input {...p} type="date" value={String(f.extras.min ?? "")} disabled={readOnly} onChange={(e) => ex("min", e.target.value)} />}</Field><Field label={t("props.max")}>{(p) => <Input {...p} type="date" value={String(f.extras.max ?? "")} disabled={readOnly} onChange={(e) => ex("max", e.target.value)} />}</Field></div>
        : (keys.includes("min") && keys.includes("max")) ? <div className="grid grid-cols-2 gap-2"><Field label={t("props.min")}>{(p) => <Input {...p} type="number" value={String(f.extras.min ?? "")} disabled={readOnly} onChange={num("min")} />}</Field><Field label={t("props.max")}>{(p) => <Input {...p} type="number" value={String(f.extras.max ?? "")} disabled={readOnly} onChange={num("max")} />}</Field></div> : null}
      {keys.includes("decimals") && <Field label={t("props.decimals")}>{(p) => <Input {...p} type="number" min={0} max={6} value={String(f.extras.decimals ?? "")} disabled={readOnly} onChange={num("decimals")} />}</Field>}
      {keys.includes("maxBytes") && <Field label={t("props.maxBytes")}>{(p) => <Input {...p} type="number" min={1} max={25} value={f.extras.maxBytes ? String(Number(f.extras.maxBytes) / 1048576) : ""} disabled={readOnly} onChange={(e) => ex("maxBytes", e.target.value === "" ? "" : Math.round(Number(e.target.value) * 1048576))} />}</Field>}
      {acceptsDefault(f.type) && <Field label={t("props.default")}>{(p) => <Input {...p} value={f.defaultValue} disabled={readOnly} maxLength={500} onChange={(e) => onChange({ defaultValue: e.target.value })} />}</Field>}
      <p className="num text-xs text-muted">{t("props.position")}: {(f.x * 100).toFixed(1)}%, {(f.y * 100).toFixed(1)}% · {(f.w * 100).toFixed(1)}×{(f.h * 100).toFixed(1)}%</p>
      {!readOnly && <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button size="sm" onClick={onDuplicate}><Copy className="size-3.5" aria-hidden />{t("props.duplicate")}</Button>
        {(f.type === "signature" || f.type === "initials") && pageCount > 1 && <Button size="sm" onClick={onEvery}><Layers className="size-3.5" aria-hidden />{t("props.everyPage")}</Button>}
        <Button size="sm" variant="danger" onClick={onDelete}><Trash2 className="size-3.5" aria-hidden />{t("props.delete")}</Button></div>}
    </div>
  );
}
