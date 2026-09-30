"use client";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select, SwitchField, Textarea } from "@/components/ui/form";
import { cn } from "@/components/ui/cn";

export type FieldDef = { key: string; type: string; label: string; help?: string; placeholder?: string; required?: boolean; options?: Array<{ value: string; label: string }>; variable?: string; variableMap?: Record<string, string>; acknowledgement?: string; [k: string]: unknown };
export type SectionDef = { key: string; title: string; description?: string; fields: FieldDef[]; [k: string]: unknown };
export type FormSchemaT = { sections: SectionDef[] };
export type Settings = { description: string; language: string; expiryDays: number; notifyEmails: string[]; allowResume: boolean; fixedValues: Record<string, string>; privacyNotice: { enabled: boolean; text: string }; signers: { order: string; bilit?: { name: string; email: string }; [k: string]: unknown }; [k: string]: unknown };
export type Coverage = { needed: string[]; fromForm: string[]; fixed: string[]; derived: string[]; auto: string[]; missing: string[] };

const move = <T,>(xs: T[], i: number, d: -1 | 1): T[] => { const j = i + d; if (j < 0 || j >= xs.length) return xs; const c = [...xs]; [c[i], c[j]] = [c[j]!, c[i]!]; return c; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f$1").slice(0, 40) || "field";

function Preview({ f }: { f: FieldDef }) {
  const t = useTranslations("intake.builder");
  const ph = f.placeholder ?? "";
  const base = "pointer-events-none";
  let ctl: React.ReactNode;
  if (f.type === "long_text") ctl = <Textarea className={base} readOnly placeholder={ph} tabIndex={-1} />;
  else if (f.type === "dropdown" || f.type === "country") ctl = <Select className={base} tabIndex={-1} defaultValue=""><option value="">{f.type === "country" ? t("countryPreview") : "—"}</option>{f.options?.map((o) => <option key={o.value}>{o.label}</option>)}</Select>;
  else if (f.type === "radio") ctl = <div className="space-y-1">{f.options?.map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" readOnly tabIndex={-1} className={base} />{o.label}</label>)}</div>;
  else if (f.type === "checkbox" || f.type === "acknowledgement") ctl = <label className="flex items-start gap-2 text-sm"><input type="checkbox" readOnly tabIndex={-1} className={cn(base, "mt-1")} />{f.acknowledgement ?? f.label}</label>;
  else if (f.type === "file" || f.type === "files") ctl = <div className="rounded-xl border-2 border-dashed border-line-strong p-3 text-sm text-muted">{t("uploadPreview")}</div>;
  else if (f.type === "signature" || f.type === "initials") ctl = <div className="grid h-16 place-items-center rounded-xl border border-dashed border-line-strong text-sm text-muted">{f.type === "signature" ? t("signaturePreview") : t("initialsPreview")}</div>;
  else ctl = <Input className={base} readOnly tabIndex={-1} placeholder={ph} type={f.type === "date" ? "date" : f.type === "time" ? "time" : f.type === "number" || f.type === "currency" ? "number" : "text"} />;
  return <div className="space-y-1"><p className="text-sm font-medium">{f.label}{f.required && <span className="text-danger" aria-hidden> *</span>}</p>{ctl}{f.help && <p className="text-xs text-muted">{f.help}</p>}</div>;
}

export function FormBuilder({ schema, onSchema, settings, onSettings, coverage, presets, fieldTypes, readOnly }: {
  schema: FormSchemaT; onSchema: (s: FormSchemaT) => void; settings: Settings; onSettings: (s: Settings) => void; coverage: Coverage | null;
  presets: Record<string, FieldDef>; fieldTypes: string[]; readOnly: boolean;
}) {
  const t = useTranslations("intake.builder");
  const [si, setSi] = useState(0);
  const [fi, setFi] = useState<number | null>(null);
  useEffect(() => { if (si >= schema.sections.length) setSi(Math.max(0, schema.sections.length - 1)); }, [schema.sections.length, si]);
  const sec = schema.sections[si];
  const fld = sec && fi !== null ? sec.fields[fi] : undefined;
  const patchSec = (p: Partial<SectionDef>) => onSchema({ sections: schema.sections.map((s, i) => (i === si ? { ...s, ...p } : s)) });
  const patchFld = (p: Partial<FieldDef>) => sec && fi !== null && patchSec({ fields: sec.fields.map((f, i) => (i === fi ? { ...f, ...p } : f)) });
  const allKeys = useMemo(() => new Set(schema.sections.flatMap((s) => s.fields.map((f) => f.key))), [schema]);
  const uniqueKey = (base: string) => { let k = base, n = 2; while (allKeys.has(k)) k = `${base}_${n++}`; return k; };
  const addField = (f: FieldDef) => { if (!sec) return; patchSec({ fields: [...sec.fields, f] }); setFi(sec.fields.length); };
  const addPreset = (k: string) => { const p = presets[k]; if (p && !allKeys.has(p.key)) addField(p); };
  const addCustom = () => addField({ key: uniqueKey("new_field"), type: "text", label: t("newField"), required: false });
  const addSection = () => { const key = uniqueKey(`section_${schema.sections.length + 1}`); onSchema({ sections: [...schema.sections, { key, title: t("newSection"), fields: [] }] }); setSi(schema.sections.length); setFi(null); };
  const usedPresets = new Set(schema.sections.flatMap((s) => s.fields.map((f) => f.preset as string | undefined).filter(Boolean)));
  const dis = readOnly;
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      {/* Structure */}
      <aside className="space-y-3">
        <div className="rounded-card border border-line bg-surface p-3 shadow-card">
          <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{t("sections")}</h2>{!dis && <Button size="sm" onClick={addSection}><Plus className="size-3.5" aria-hidden />{t("add")}</Button>}</div>
          <ul className="space-y-1">{schema.sections.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              <button type="button" onClick={() => { setSi(i); setFi(null); }} aria-current={i === si} className={cn("min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-start text-sm", i === si ? "bg-surface-2 font-medium" : "hover:bg-surface-2")}>{s.title}<span className="num ms-1.5 text-xs text-muted">{s.fields.length}</span></button>
              {!dis && <><button type="button" aria-label={t("moveUp")} disabled={i === 0} onClick={() => { onSchema({ sections: move(schema.sections, i, -1) }); setSi(i - 1); }} className="grid size-7 place-items-center rounded-lg hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                <button type="button" aria-label={t("moveDown")} disabled={i === schema.sections.length - 1} onClick={() => { onSchema({ sections: move(schema.sections, i, 1) }); setSi(i + 1); }} className="grid size-7 place-items-center rounded-lg hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="size-3.5" /></button></>}
            </li>))}</ul>
        </div>
        {sec && (
          <div className="rounded-card border border-line bg-surface p-3 shadow-card">
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{t("fields")}</h2>{!dis && <Button size="sm" onClick={addCustom}><Plus className="size-3.5" aria-hidden />{t("add")}</Button>}</div>
            <ul className="space-y-1">{sec.fields.map((f, i) => (
              <li key={f.key} className="flex items-center gap-1">
                <button type="button" onClick={() => setFi(i)} aria-current={i === fi} className={cn("min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-start text-sm", i === fi ? "bg-surface-2 font-medium" : "hover:bg-surface-2")}>{f.label}<span className="block truncate text-xs text-muted">{f.type}{f.required ? " · *" : ""}</span></button>
                {!dis && <><button type="button" aria-label={t("moveUp")} disabled={i === 0} onClick={() => { patchSec({ fields: move(sec.fields, i, -1) }); setFi(i - 1); }} className="grid size-7 place-items-center rounded-lg hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                  <button type="button" aria-label={t("moveDown")} disabled={i === sec.fields.length - 1} onClick={() => { patchSec({ fields: move(sec.fields, i, 1) }); setFi(i + 1); }} className="grid size-7 place-items-center rounded-lg hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="size-3.5" /></button></>}
              </li>))}</ul>
            {!dis && <div className="mt-3 border-t border-line pt-3"><Select aria-label={t("addPreset")} value="" onChange={(e) => e.target.value && addPreset(e.target.value)}><option value="">{t("addPreset")}</option>{Object.entries(presets).filter(([k, p]) => !usedPresets.has(k) && !allKeys.has(p.key)).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select></div>}
          </div>)}
      </aside>

      {/* Live preview */}
      <section className="min-w-0 space-y-4">
        <div className="rounded-card border border-line bg-surface p-5 shadow-card">
          {sec ? <><h2 className="text-lg font-semibold">{sec.title}</h2>{sec.description && <p className="mb-3 text-sm text-muted">{sec.description}</p>}
            <div className="mt-3 space-y-4">{sec.fields.map((f, i) => <button key={f.key} type="button" onClick={() => setFi(i)} className={cn("block w-full rounded-xl border p-3 text-start", i === fi ? "border-accent" : "border-transparent hover:border-line")}><Preview f={f} /></button>)}{!sec.fields.length && <p className="text-sm text-muted">{t("emptySection")}</p>}</div></> : null}
        </div>
        {coverage && (
          <div className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 className="mb-2 text-sm font-semibold">{t("coverage")}</h2>
            {coverage.missing.length ? <Callout tone="warn" title={t("missingTitle")}><div className="flex flex-wrap gap-1.5">{coverage.missing.map((m) => <code key={m} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{m}</code>)}</div><p className="mt-2 text-sm">{t("missingHint")}</p></Callout> : <Callout tone="ok">{t("covered", { n: coverage.needed.length })}</Callout>}
          </div>)}
      </section>

      {/* Properties */}
      <aside className="space-y-3">
        <div className="rounded-card border border-line bg-surface p-4 shadow-card">
          {sec && fi === null && (<div className="space-y-3"><h2 className="text-sm font-semibold">{t("sectionProps")}</h2>
            <Field label={t("title")}>{(p) => <Input {...p} disabled={dis} value={sec.title} onChange={(e) => patchSec({ title: e.target.value })} maxLength={200} />}</Field>
            <Field label={t("description")}>{(p) => <Textarea {...p} disabled={dis} value={sec.description ?? ""} onChange={(e) => patchSec({ description: e.target.value || undefined })} maxLength={1000} />}</Field>
            {!dis && schema.sections.length > 1 && <Button variant="danger" size="sm" onClick={() => { onSchema({ sections: schema.sections.filter((_, i) => i !== si) }); setFi(null); }}><Trash2 className="size-3.5" aria-hidden />{t("removeSection")}</Button>}</div>)}
          {fld && sec && (<div className="space-y-3"><h2 className="text-sm font-semibold">{t("fieldProps")}</h2>
            <Field label={t("label")}>{(p) => <Input {...p} disabled={dis} value={fld.label} onChange={(e) => patchFld({ label: e.target.value })} maxLength={200} />}</Field>
            <Field label={t("key")} hint={t("keyHint")}>{(p) => <Input {...p} disabled={dis || !!fld.preset} value={fld.key} onChange={(e) => patchFld({ key: slug(e.target.value) })} />}</Field>
            <Field label={t("type")}>{(p) => <Select {...p} disabled={dis} value={fld.type} onChange={(e) => patchFld({ type: e.target.value })}>{fieldTypes.map((x) => <option key={x} value={x}>{t(`types.${x}` as never)}</option>)}</Select>}</Field>
            <Checkbox label={t("required")} disabled={dis} checked={!!fld.required} onChange={(e) => patchFld({ required: e.target.checked })} />
            <Field label={t("help")}>{(p) => <Input {...p} disabled={dis} value={fld.help ?? ""} onChange={(e) => patchFld({ help: e.target.value || undefined })} maxLength={500} />}</Field>
            <Field label={t("placeholder")}>{(p) => <Input {...p} disabled={dis} value={fld.placeholder ?? ""} onChange={(e) => patchFld({ placeholder: e.target.value || undefined })} maxLength={200} />}</Field>
            {(fld.type === "dropdown" || fld.type === "radio") && <Field label={t("options")} hint={t("optionsHint")}>{(p) => <Textarea {...p} disabled={dis} defaultValue={(fld.options ?? []).map((o) => o.label).join("\n")} onBlur={(e) => patchFld({ options: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean).map((l) => ({ value: l, label: l })) })} />}</Field>}
            {fld.type === "acknowledgement" && <Field label={t("ackText")}>{(p) => <Textarea {...p} disabled={dis} value={fld.acknowledgement ?? ""} onChange={(e) => patchFld({ acknowledgement: e.target.value })} maxLength={2000} />}</Field>}
            {!["person", "company", "address", "file", "files", "signature", "initials"].includes(fld.type) && <Field label={t("variable")} hint={t("variableHint")}>{(p) => <Input {...p} disabled={dis} value={fld.variable ?? ""} onChange={(e) => patchFld({ variable: e.target.value.trim() || undefined })} placeholder="organiser_name" />}</Field>}
            {!dis && <Button variant="danger" size="sm" onClick={() => { patchSec({ fields: sec.fields.filter((_, i) => i !== fi) }); setFi(null); }}><Trash2 className="size-3.5" aria-hidden />{t("removeField")}</Button>}</div>)}
        </div>
        <div className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold">{t("formSettings")}</h2>
          <Field label={t("expiryDays")}>{(p) => <Input {...p} type="number" min={1} max={180} disabled={dis} value={settings.expiryDays} onChange={(e) => onSettings({ ...settings, expiryDays: Number(e.target.value) })} />}</Field>
          <Field label={t("notifyEmails")} hint={t("onePerLine")}>{(p) => <Textarea {...p} disabled={dis} defaultValue={settings.notifyEmails.join("\n")} onBlur={(e) => onSettings({ ...settings, notifyEmails: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} />}</Field>
          <SwitchField checked={settings.allowResume} disabled={dis} onChange={(v) => onSettings({ ...settings, allowResume: v })} label={t("allowResume")} />
          <SwitchField checked={settings.privacyNotice.enabled} disabled={dis} onChange={(v) => onSettings({ ...settings, privacyNotice: { ...settings.privacyNotice, enabled: v } })} label={t("privacyNotice")} />
          {settings.privacyNotice.enabled && <Textarea aria-label={t("privacyNotice")} disabled={dis} value={settings.privacyNotice.text} onChange={(e) => onSettings({ ...settings, privacyNotice: { ...settings.privacyNotice, text: e.target.value } })} maxLength={2000} />}
          <Field label={t("fixedValues")} hint={t("fixedHint")}>{(p) => <Textarea {...p} disabled={dis} defaultValue={Object.entries(settings.fixedValues).map(([k, v]) => `${k}=${v}`).join("\n")} onBlur={(e) => onSettings({ ...settings, fixedValues: Object.fromEntries(e.target.value.split("\n").map((l) => l.split(/=(.*)/s)).filter((p) => p[0]?.trim() && p[1] !== undefined).map((p) => [p[0]!.trim(), p[1]!.trim()])) })} />}</Field>
        </div>
      </aside>
    </div>
  );
}
