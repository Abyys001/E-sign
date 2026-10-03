"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, FileUp, LayoutTemplate, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { useMe } from "@/components/app/me";
import { api, errMsg, useApi } from "@/lib/api";

type Source = "pdf" | "template" | "duplicate";
type TemplateRow = { id: string; name: string; publishedVersion: number | null; contractType: string };
type Variable = { key: string; label: string; type: string; required: boolean; default?: string };
type Role = { key: string; name: string; role: string; required: boolean; defaultName?: string; defaultEmail?: string };
type TemplateDetail = { versions: Array<{ id: string; version: number; published: boolean; variables: Variable[]; recipientRoles: Role[] }> };
type ContractRow = { id: string; name: string; reference: string };

export default function NewContract() { return <Suspense><Wizard /></Suspense>; }

function Wizard() {
  const t = useTranslations("contracts.new");
  const c = useTranslations("common");
  const router = useRouter();
  const sp = useSearchParams();
  const { me } = useMe();
  const [source, setSource] = useState<Source>((sp.get("template") ? "template" : sp.get("duplicate") ? "duplicate" : "pdf"));
  const [name, setName] = useState("");
  const [type, setType] = useState(t("typeDefault"));
  const [message, setMessage] = useState("");
  const [expires, setExpires] = useState(() => new Date(Date.now() + me.settings.signing.defaultExpiryDays * 86400_000).toISOString().slice(0, 10));
  const [order, setOrder] = useState(me.settings.signing.defaultSigningOrder);
  const [file, setFile] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState(sp.get("template") ?? "");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Record<string, { name: string; email: string }>>({});
  const [dupId, setDupId] = useState(sp.get("duplicate") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const drop = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const templates = useApi<{ items: TemplateRow[] }>(source === "template" ? "/api/templates?status=PUBLISHED" : null);
  const detail = useApi<TemplateDetail>(source === "template" && templateId ? `/api/templates/${templateId}` : null);
  const contracts = useApi<{ items: ContractRow[] }>(source === "duplicate" ? "/api/contracts?pageSize=100" : null);
  const version = detail.data?.versions.filter((v) => v.published).at(-1);
  // Roles with a usual person (e.g. the Bilit signer) start pre-filled; the sender can still change them.
  useEffect(() => {
    const defaults = Object.fromEntries((version?.recipientRoles ?? []).filter((r) => r.defaultName && r.defaultEmail).map((r) => [r.key, { name: r.defaultName!, email: r.defaultEmail! }]));
    if (Object.keys(defaults).length) setPeople((s) => ({ ...defaults, ...s }));
  }, [version?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = (f: File | undefined) => { if (f) { setFile(f); if (!name) setName(f.name.replace(/\.pdf$/i, "")); } };
  const ready = name.trim() && (source === "pdf" ? !!file : source === "template" ? !!version && (version.variables ?? []).every((v) => !v.required || vars[v.key]?.trim()) && (version.recipientRoles ?? []).every((r) => !r.required || (people[r.key]?.name && people[r.key]?.email)) : !!dupId);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const common = { name: name.trim(), contractType: type.trim() || undefined, message: message.trim() || null, signingOrder: order, expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null };
      if (source === "duplicate") { const r = await api<{ id: string }>("/api/contracts", { json: { ...common, duplicateOf: dupId } }); router.push(`/contracts/${r.id}`); return; }
      if (source === "template") {
        const r = await api<{ id: string }>("/api/contracts", { json: { ...common, templateVersionId: version!.id, variables: vars, recipients: (version!.recipientRoles ?? []).filter((x) => people[x.key]?.email).map((x) => ({ roleKey: x.key, name: people[x.key]!.name, email: people[x.key]!.email })) } });
        router.push(`/contracts/${r.id}`); return;
      }
      const made = await api<{ id: string }>("/api/contracts", { json: common });
      const form = new FormData(); form.set("file", file!);
      try { await api(`/api/contracts/${made.id}/document`, { form }); }
      catch (x) { setErr(errMsg(x)); router.push(`/contracts/${made.id}`); return; }
      router.push(`/contracts/${made.id}/prepare`);
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  const SRC: Array<{ id: Source; icon: React.ReactNode; title: string; desc: string }> = [
    { id: "pdf", icon: <FileUp className="size-5" />, title: t("fromPdf"), desc: t("fromPdfDesc") },
    { id: "template", icon: <LayoutTemplate className="size-5" />, title: t("fromTemplate"), desc: t("fromTemplateDesc") },
    { id: "duplicate", icon: <Copy className="size-5" />, title: t("duplicate"), desc: t("duplicateDesc") },
  ];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("title")} description={t("sub")} />
      <div role="radiogroup" aria-label={t("title")} className="mb-6 grid gap-3 sm:grid-cols-3">
        {SRC.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={source === s.id} onClick={() => setSource(s.id)}
            className={cn("rounded-card border p-4 text-start transition", source === s.id ? "border-2 border-fg bg-surface shadow-card" : "border-line bg-surface hover:border-line-strong")}>
            <span className={cn("mb-3 grid size-10 place-items-center rounded-xl", source === s.id ? "bg-accent text-accent-fg" : "bg-surface-2")}>{s.icon}</span>
            <span className="block text-sm font-semibold">{s.title}</span><span className="mt-0.5 block text-xs text-muted">{s.desc}</span>
          </button>
        ))}
      </div>
      <form onSubmit={create} className="space-y-6">
        {source === "pdf" && (
          <Card className="p-5">
            <input ref={drop} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label={t("file")} onChange={(e) => pickFile(e.target.files?.[0])} />
            <button type="button" onClick={() => drop.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files[0]); }}
              className={cn("flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition", over ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface-2")}>
              <UploadCloud className="size-8" aria-hidden />
              <span className="text-sm font-medium">{file ? file.name : t("dropHere")}</span>
              <span className="text-xs text-muted">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · ${t("replace")}` : t("fileHint", { mb: 25 })}</span>
            </button>
          </Card>
        )}
        {source === "template" && (
          <Card className="space-y-4 p-5">
            {templates.data && templates.data.items.length === 0 ? <Callout title={t("noTemplates")} /> : (
              <Field label={t("template")} required>{(p) => <Select {...p} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); setPeople({}); }}><option value="">{t("pickTemplate")}</option>{templates.data?.items.filter((x) => x.publishedVersion).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
            )}
            {version && (version.variables ?? []).length > 0 && (<div className="space-y-3 border-t border-line pt-4"><h3 className="text-sm font-semibold">{t("variables")}</h3>
              {version.variables.map((v) => <Field key={v.key} label={v.label} required={v.required}>{(p) => <Input {...p} type={v.type === "date" ? "date" : v.type === "number" || v.type === "currency" ? "number" : "text"} value={vars[v.key] ?? v.default ?? ""} onChange={(e) => setVars((s) => ({ ...s, [v.key]: e.target.value }))} />}</Field>)}</div>)}
            {version && (version.recipientRoles ?? []).length > 0 && (<div className="space-y-3 border-t border-line pt-4"><h3 className="text-sm font-semibold">{t("roles")}</h3>
              {version.recipientRoles.map((r) => <div key={r.key} className="grid gap-3 sm:grid-cols-2"><Field label={`${r.name}${r.required ? "" : ` (${t("roleOptional")})`} — ${c("name")}`} required={r.required}>{(p) => <Input {...p} value={people[r.key]?.name ?? ""} onChange={(e) => setPeople((s) => ({ ...s, [r.key]: { name: e.target.value, email: s[r.key]?.email ?? "" } }))} />}</Field><Field label={c("email")} required={r.required}>{(p) => <Input {...p} type="email" value={people[r.key]?.email ?? ""} onChange={(e) => setPeople((s) => ({ ...s, [r.key]: { email: e.target.value, name: s[r.key]?.name ?? "" } }))} />}</Field></div>)}</div>)}
          </Card>
        )}
        {source === "duplicate" && (
          <Card className="p-5"><Field label={t("pickContract")} required>{(p) => <Select {...p} value={dupId} onChange={(e) => { setDupId(e.target.value); const m = contracts.data?.items.find((x) => x.id === e.target.value); if (m && !name) setName(`${m.name} (copy)`); }}><option value="" />{contracts.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.reference}</option>)}</Select>}</Field></Card>
        )}
        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">{t("details")}</h2>
          <Field label={t("name")} required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePh")} maxLength={200} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("type")}>{(p) => <Input {...p} value={type} onChange={(e) => setType(e.target.value)} maxLength={60} />}</Field>
            <Field label={t("expires")} hint={t("expiresHint")}>{(p) => <Input {...p} type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />}</Field>
          </div>
          <Field label={t("order")}>{(p) => <Select {...p} value={order} onChange={(e) => setOrder(e.target.value)}><option value="SEQUENTIAL">{t("sequential")}</option><option value="PARALLEL">{t("parallel")}</option></Select>}</Field>
          <Field label={t("message")} hint={t("messageHint")}>{(p) => <Textarea {...p} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />}</Field>
        </Card>
        {err && <Callout tone="warn" title={err} />}
        <div className="flex justify-end gap-2"><Button onClick={() => router.back()}>{c("cancel")}</Button><Button type="submit" variant="primary" loading={busy} disabled={!ready}>{busy ? t("creating") : t("create")}</Button></div>
      </form>
    </div>
  );
}
