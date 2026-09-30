import sanitizeHtml from "sanitize-html";
import { env } from "@/lib/env";
import { ALL_VARS, HTML_VARS, extractVars, type Locale } from "./templates";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Org-edited template bodies are untrusted HTML: keep a small formatting whitelist, https/mailto links only. */
export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "a", "ul", "ol", "li", "h2", "h3", "hr", "span", "div", "table", "tbody", "tr", "td"],
    allowedAttributes: { a: ["href", "title"], span: ["style", "dir"], div: ["style", "dir"], p: ["style", "dir"], td: ["style"] },
    allowedStyles: { "*": { "text-align": [/^(left|right|center)$/], "font-size": [/^\d+(px|%)$/], "font-weight": [/^\d+$|^bold$/], "letter-spacing": [/^\d+px$/] } },
    allowedSchemes: ["https", "mailto"],
    disallowedTagsMode: "discard",
  });
}

export function renderVars(tpl: string, vars: Record<string, string>, opts: { html: boolean }): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    if (!ALL_VARS.includes(name)) throw new Error(`Unknown template variable: ${name}`);
    const v = vars[name] ?? "";
    return (HTML_VARS as readonly string[]).includes(name) || !opts.html ? v : esc(v);
  });
}

export type Brand = { orgName: string; primary: string; onPrimary: string; footer: string; supportEmail: string; supportPhone: string };

/** Contrast pick so the button label stays readable on any organisation colour. */
export function onColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return L > 0.4 ? "#000000" : "#ffffff";
}

export function buttonHtml(url: string, label: string, brand: Brand): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="background:${brand.primary};border-radius:8px"><a href="${esc(url)}" style="display:inline-block;padding:14px 28px;font-weight:600;font-size:16px;color:${brand.onPrimary};text-decoration:none">${esc(label)}</a></td></tr></table><p style="font-size:13px;color:#6e6e73;margin:0 0 8px">If the button does not work, copy this link:<br><a href="${esc(url)}" style="color:#6e6e73;word-break:break-all">${esc(url)}</a></p>`;
}

/** Shared email shell: Bilit.event E-Sign logo (inline CID), organisation name, footer, support line. Colours come from the project palette. */
export function layout(inner: string, brand: Brand, locale: Locale, title: string): string {
  const dir = locale === "fa" ? "rtl" : "ltr";
  const support = [brand.supportEmail && `<a href="mailto:${esc(brand.supportEmail)}" style="color:#6e6e73">${esc(brand.supportEmail)}</a>`, brand.supportPhone && esc(brand.supportPhone)].filter(Boolean).join(" · ");
  const font = locale === "fa" ? "Vazirmatn,Tahoma,Arial,sans-serif" : "'Google Sans Flex','Google Sans',Helvetica,Arial,sans-serif";
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f5f5f7;font-family:${font};color:#0d0d12"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px">
<tr><td style="padding:28px 32px 8px"><img src="cid:bilit-logo" alt="Bilit.event E-Sign" width="132" height="33" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6e6e73">${esc(brand.orgName)}</td></tr>
<tr><td style="padding:8px 32px 28px;font-size:15px;line-height:1.6">${inner}</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #f5f5f7;font-size:12px;line-height:1.6;color:#6e6e73">${brand.footer ? `${esc(brand.footer)}<br>` : ""}${support ? `Need help? ${support}<br>` : ""}Sent with Bilit.event E-Sign</td></tr>
</table></td></tr></table></body></html>`;
}

export const stripHtml = (h: string) =>
  h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|table)>/gi, "\n\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, u: string, l: string) => (l.trim() === u ? u : `${l} (${u})`)).replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();

export const appUrl = (path: string) => new URL(path, env().APP_URL).toString();
export { extractVars };
