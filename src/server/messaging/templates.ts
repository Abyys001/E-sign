export type Locale = "en" | "fa";
export const EMAIL_TEMPLATE_KEYS = [
  "signature_requested", "contract_sent", "contract_viewed", "reminder", "almost_expired", "expired", "completed", "all_signatures_completed",
  "declined", "cancelled", "voided", "recipient_added", "recipient_removed", "signer_completed", "otp_code", "invite", "password_reset",
  "intake_invitation", "intake_reminder", "intake_submitted", "contract_generated", "contract_ready_for_review", "contract_rescheduled", "refund_notice",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Plain variables are HTML-escaped. `signing_button` / `download_button` are trusted server-built HTML. */
export const TEXT_VARS = [
  "recipient_name", "sender_name", "contract_name", "contract_reference", "signing_url", "download_url", "expiry_date", "organisation_name",
  "support_email", "support_phone", "message", "decline_reason", "otp_code", "signer_name", "invite_url", "days_left", "reason",
  "form_title", "form_url", "event_name", "review_url", "new_event_date", "refund_details", "submitted_by",
] as const;
export const HTML_VARS = ["signing_button", "download_button", "invite_button", "form_button", "review_button"] as const;
export const ALL_VARS: readonly string[] = [...TEXT_VARS, ...HTML_VARS];

type T = { subject: string; body: string };
const p = (s: string) => `<p>${s}</p>`;

const en: Record<EmailTemplateKey, T> = {
  signature_requested: { subject: "{{sender_name}} sent you “{{contract_name}}” to sign", body: p("Hello {{recipient_name}},") + p("<strong>{{sender_name}}</strong> from {{organisation_name}} has asked you to review and sign <strong>{{contract_name}}</strong> ({{contract_reference}}).") + p("{{message}}") + "{{signing_button}}" + p("This link is personal to you and expires on {{expiry_date}}. Please do not forward this email.") },
  contract_sent: { subject: "“{{contract_name}}” was sent for signature", body: p("Hello {{recipient_name}},") + p("<strong>{{contract_name}}</strong> ({{contract_reference}}) has been sent for signature by {{sender_name}}. You will be notified as each person signs.") },
  contract_viewed: { subject: "{{signer_name}} viewed “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("<strong>{{signer_name}}</strong> opened <strong>{{contract_name}}</strong> ({{contract_reference}}).") },
  reminder: { subject: "Reminder: “{{contract_name}}” is waiting for your signature", body: p("Hello {{recipient_name}},") + p("This is a reminder that <strong>{{contract_name}}</strong> from {{organisation_name}} is still waiting for your signature. It expires on {{expiry_date}}.") + "{{signing_button}}" },
  almost_expired: { subject: "“{{contract_name}}” expires in {{days_left}} day(s)", body: p("Hello {{recipient_name}},") + p("<strong>{{contract_name}}</strong> expires on {{expiry_date}}. Please sign before then.") + "{{signing_button}}" },
  expired: { subject: "“{{contract_name}}” has expired", body: p("Hello {{recipient_name}},") + p("<strong>{{contract_name}}</strong> ({{contract_reference}}) expired before all signatures were collected. It can no longer be signed. Contact {{sender_name}} if you still need it.") },
  completed: { subject: "Completed: “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("Everyone has signed <strong>{{contract_name}}</strong> ({{contract_reference}}). Your completed copy is ready.") + "{{download_button}}" },
  all_signatures_completed: { subject: "All signatures collected: “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("All parties have signed <strong>{{contract_name}}</strong> ({{contract_reference}}). The final document and completion certificate are available in Bilit.event E-Sign.") + "{{download_button}}" },
  declined: { subject: "{{signer_name}} declined “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("<strong>{{signer_name}}</strong> declined to sign <strong>{{contract_name}}</strong> ({{contract_reference}}).") + p("Reason: {{decline_reason}}") },
  cancelled: { subject: "“{{contract_name}}” was cancelled", body: p("Hello {{recipient_name}},") + p("<strong>{{contract_name}}</strong> ({{contract_reference}}) was cancelled by {{sender_name}}. You no longer need to sign it.") },
  voided: { subject: "“{{contract_name}}” was voided", body: p("Hello {{recipient_name}},") + p("<strong>{{contract_name}}</strong> ({{contract_reference}}) was voided by {{sender_name}}. Reason: {{reason}}") },
  recipient_added: { subject: "You were added to “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("{{sender_name}} added you to <strong>{{contract_name}}</strong> ({{contract_reference}}).") },
  recipient_removed: { subject: "You were removed from “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("{{sender_name}} removed you from <strong>{{contract_name}}</strong> ({{contract_reference}}). Any earlier link no longer works.") },
  signer_completed: { subject: "{{signer_name}} signed “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("<strong>{{signer_name}}</strong> signed <strong>{{contract_name}}</strong> ({{contract_reference}}).") },
  otp_code: { subject: "Your verification code: {{otp_code}}", body: p("Hello {{recipient_name}},") + p("Your code to open <strong>{{contract_name}}</strong> is:") + `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">{{otp_code}}</p>` + p("It expires in a few minutes. If you did not request it, ignore this email.") },
  password_reset: { subject: "Reset your Bilit.event E-Sign password", body: p("Hello {{recipient_name}},") + p("We received a request to reset your password. This link works once and expires in one hour.") + "{{invite_button}}" + p("If you did not ask for this, you can ignore this email.") },
  invite: { subject: "You have been invited to {{organisation_name}} on Bilit.event E-Sign", body: p("Hello {{recipient_name}},") + p("{{sender_name}} invited you to join <strong>{{organisation_name}}</strong>.") + "{{invite_button}}" + p("This invitation expires in 7 days.") },
  intake_invitation: { subject: "{{sender_name}} invited you to complete “{{form_title}}”", body: p("Hello {{recipient_name}},") + p("<strong>{{sender_name}}</strong> from {{organisation_name}} needs some information from you to prepare an agreement: <strong>{{form_title}}</strong>.") + p("{{message}}") + "{{form_button}}" + p("The form is private to you and can be saved and finished later. The link expires on {{expiry_date}}. Please do not forward this email. Questions? Contact {{support_email}}.") },
  intake_reminder: { subject: "Reminder: please complete “{{form_title}}”", body: p("Hello {{recipient_name}},") + p("This is a reminder that <strong>{{form_title}}</strong> from {{organisation_name}} has not been submitted yet. Your saved answers are waiting for you. The link expires on {{expiry_date}}.") + "{{form_button}}" },
  intake_submitted: { subject: "{{submitted_by}} submitted “{{form_title}}”", body: p("Hello {{recipient_name}},") + p("<strong>{{submitted_by}}</strong> submitted <strong>{{form_title}}</strong>. The configured contract workflow has started.") + "{{review_button}}" },
  contract_generated: { subject: "Your agreement “{{contract_name}}” has been prepared", body: p("Hello {{recipient_name}},") + p("Thank you. <strong>{{contract_name}}</strong> ({{contract_reference}}) has been prepared from the information you submitted. You will receive a separate email when it is ready for your signature.") },
  contract_ready_for_review: { subject: "Review needed: “{{contract_name}}”", body: p("Hello {{recipient_name}},") + p("<strong>{{contract_name}}</strong> ({{contract_reference}}) was generated from an intake submission and is waiting for staff review before it is sent for signature.") + "{{review_button}}" },
  contract_rescheduled: { subject: "“{{event_name}}” has been rescheduled", body: p("Hello {{recipient_name}},") + p("<strong>{{event_name}}</strong> has been rescheduled to <strong>{{new_event_date}}</strong>.") + p("{{refund_details}}") + p("Questions? Contact {{support_email}}.") },
  refund_notice: { subject: "Refund information for “{{event_name}}”", body: p("Hello {{recipient_name}},") + p("We are writing about your tickets for <strong>{{event_name}}</strong>.") + p("{{refund_details}}") + p("Questions? Contact {{support_email}}.") },
};

const fa: Record<EmailTemplateKey, T> = {
  signature_requested: { subject: "{{sender_name}} سند «{{contract_name}}» را برای امضای شما ارسال کرد", body: p("سلام {{recipient_name}}،") + p("<strong>{{sender_name}}</strong> از {{organisation_name}} از شما خواسته سند <strong>{{contract_name}}</strong> ({{contract_reference}}) را بررسی و امضا کنید.") + p("{{message}}") + "{{signing_button}}" + p("این پیوند مخصوص شماست و تا {{expiry_date}} معتبر است. لطفاً آن را برای دیگران ارسال نکنید.") },
  contract_sent: { subject: "«{{contract_name}}» برای امضا ارسال شد", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> ({{contract_reference}}) توسط {{sender_name}} برای امضا ارسال شد. با امضای هر نفر به شما اطلاع داده می‌شود.") },
  contract_viewed: { subject: "{{signer_name}} سند «{{contract_name}}» را مشاهده کرد", body: p("سلام {{recipient_name}}،") + p("<strong>{{signer_name}}</strong> سند <strong>{{contract_name}}</strong> ({{contract_reference}}) را باز کرد.") },
  reminder: { subject: "یادآوری: «{{contract_name}}» منتظر امضای شماست", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> از {{organisation_name}} هنوز منتظر امضای شماست. مهلت آن {{expiry_date}} است.") + "{{signing_button}}" },
  almost_expired: { subject: "«{{contract_name}}» تا {{days_left}} روز دیگر منقضی می‌شود", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> در تاریخ {{expiry_date}} منقضی می‌شود. لطفاً پیش از آن امضا کنید.") + "{{signing_button}}" },
  expired: { subject: "«{{contract_name}}» منقضی شد", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> ({{contract_reference}}) پیش از تکمیل امضاها منقضی شد و دیگر قابل امضا نیست.") },
  completed: { subject: "تکمیل شد: «{{contract_name}}»", body: p("سلام {{recipient_name}}،") + p("همه سند <strong>{{contract_name}}</strong> ({{contract_reference}}) را امضا کرده‌اند. نسخهٔ نهایی آماده است.") + "{{download_button}}" },
  all_signatures_completed: { subject: "همهٔ امضاها جمع‌آوری شد: «{{contract_name}}»", body: p("سلام {{recipient_name}}،") + p("همهٔ طرف‌ها سند <strong>{{contract_name}}</strong> ({{contract_reference}}) را امضا کردند. سند نهایی و گواهی تکمیل در Bilit.event E-Sign در دسترس است.") + "{{download_button}}" },
  declined: { subject: "{{signer_name}} سند «{{contract_name}}» را رد کرد", body: p("سلام {{recipient_name}}،") + p("<strong>{{signer_name}}</strong> از امضای <strong>{{contract_name}}</strong> ({{contract_reference}}) خودداری کرد.") + p("دلیل: {{decline_reason}}") },
  cancelled: { subject: "«{{contract_name}}» لغو شد", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> ({{contract_reference}}) توسط {{sender_name}} لغو شد و نیازی به امضای آن نیست.") },
  voided: { subject: "«{{contract_name}}» باطل شد", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> ({{contract_reference}}) توسط {{sender_name}} باطل شد. دلیل: {{reason}}") },
  recipient_added: { subject: "شما به «{{contract_name}}» افزوده شدید", body: p("سلام {{recipient_name}}،") + p("{{sender_name}} شما را به سند <strong>{{contract_name}}</strong> ({{contract_reference}}) افزود.") },
  recipient_removed: { subject: "شما از «{{contract_name}}» حذف شدید", body: p("سلام {{recipient_name}}،") + p("{{sender_name}} شما را از سند <strong>{{contract_name}}</strong> ({{contract_reference}}) حذف کرد و پیوندهای قبلی دیگر کار نمی‌کند.") },
  signer_completed: { subject: "{{signer_name}} سند «{{contract_name}}» را امضا کرد", body: p("سلام {{recipient_name}}،") + p("<strong>{{signer_name}}</strong> سند <strong>{{contract_name}}</strong> ({{contract_reference}}) را امضا کرد.") },
  otp_code: { subject: "کد تأیید شما: {{otp_code}}", body: p("سلام {{recipient_name}}،") + p("کد شما برای باز کردن <strong>{{contract_name}}</strong>:") + `<p dir="ltr" style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">{{otp_code}}</p>` + p("این کد چند دقیقه اعتبار دارد. اگر آن را درخواست نکرده‌اید، این ایمیل را نادیده بگیرید.") },
  password_reset: { subject: "بازنشانی گذرواژهٔ Bilit.event E-Sign", body: p("سلام {{recipient_name}}،") + p("درخواست بازنشانی گذرواژهٔ شما دریافت شد. این پیوند یک‌بار مصرف است و یک ساعت اعتبار دارد.") + "{{invite_button}}" + p("اگر این درخواست از شما نبوده، این ایمیل را نادیده بگیرید.") },
  invite: { subject: "شما به {{organisation_name}} در Bilit.event E-Sign دعوت شده‌اید", body: p("سلام {{recipient_name}}،") + p("{{sender_name}} شما را به <strong>{{organisation_name}}</strong> دعوت کرد.") + "{{invite_button}}" + p("این دعوت‌نامه ۷ روز اعتبار دارد.") },
  intake_invitation: { subject: "{{sender_name}} از شما خواسته «{{form_title}}» را تکمیل کنید", body: p("سلام {{recipient_name}}،") + p("<strong>{{sender_name}}</strong> از {{organisation_name}} برای تهیهٔ قرارداد به اطلاعاتی از شما نیاز دارد: <strong>{{form_title}}</strong>.") + p("{{message}}") + "{{form_button}}" + p("این فرم مخصوص شماست و می‌توانید آن را ذخیره کنید و بعداً ادامه دهید. پیوند تا {{expiry_date}} معتبر است. لطفاً این ایمیل را برای دیگران ارسال نکنید. پرسش؟ با {{support_email}} تماس بگیرید.") },
  intake_reminder: { subject: "یادآوری: لطفاً «{{form_title}}» را تکمیل کنید", body: p("سلام {{recipient_name}}،") + p("فرم <strong>{{form_title}}</strong> از {{organisation_name}} هنوز ارسال نشده است. پاسخ‌های ذخیره‌شدهٔ شما آماده است. پیوند تا {{expiry_date}} معتبر است.") + "{{form_button}}" },
  intake_submitted: { subject: "{{submitted_by}} فرم «{{form_title}}» را ارسال کرد", body: p("سلام {{recipient_name}}،") + p("<strong>{{submitted_by}}</strong> فرم <strong>{{form_title}}</strong> را ارسال کرد و روند قرارداد آغاز شد.") + "{{review_button}}" },
  contract_generated: { subject: "قرارداد «{{contract_name}}» آماده شد", body: p("سلام {{recipient_name}}،") + p("سپاس. سند <strong>{{contract_name}}</strong> ({{contract_reference}}) بر پایهٔ اطلاعات شما تهیه شد. پس از آماده شدن برای امضا، ایمیل جداگانه‌ای دریافت می‌کنید.") },
  contract_ready_for_review: { subject: "نیاز به بررسی: «{{contract_name}}»", body: p("سلام {{recipient_name}}،") + p("سند <strong>{{contract_name}}</strong> ({{contract_reference}}) از فرم دریافت اطلاعات تولید شده و پیش از ارسال برای امضا منتظر بررسی است.") + "{{review_button}}" },
  contract_rescheduled: { subject: "«{{event_name}}» به تاریخ جدید موکول شد", body: p("سلام {{recipient_name}}،") + p("رویداد <strong>{{event_name}}</strong> به <strong>{{new_event_date}}</strong> موکول شد.") + p("{{refund_details}}") + p("پرسش؟ با {{support_email}} تماس بگیرید.") },
  refund_notice: { subject: "اطلاعات بازپرداخت برای «{{event_name}}»", body: p("سلام {{recipient_name}}،") + p("دربارهٔ بلیت‌های شما برای <strong>{{event_name}}</strong> می‌نویسیم.") + p("{{refund_details}}") + p("پرسش؟ با {{support_email}} تماس بگیرید.") },
};

export const DEFAULT_TEMPLATES: Record<Locale, Record<EmailTemplateKey, T>> = { en, fa };

/** Variables each template may reference. Extra variables are rejected at save time, not silently rendered blank. */
export function allowedVarsFor(key: EmailTemplateKey): readonly string[] {
  return key === "otp_code" ? [...ALL_VARS] : ALL_VARS.filter((v) => v !== "otp_code");
}

export function extractVars(s: string): string[] {
  return [...s.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!);
}

export function validateTemplate(key: EmailTemplateKey, subject: string, body: string): string[] {
  const allowed = new Set(allowedVarsFor(key));
  const bad = new Set([...extractVars(subject), ...extractVars(body)].filter((v) => !allowed.has(v)));
  const problems = [...bad].map((v) => `Unknown variable {{${v}}}`);
  if (extractVars(subject).some((v) => (HTML_VARS as readonly string[]).includes(v))) problems.push("Button variables cannot be used in the subject");
  if (/<script|javascript:|on\w+\s*=/i.test(body)) problems.push("Scripts and event handlers are not allowed");
  if (["signature_requested", "reminder", "almost_expired"].includes(key) && !/\{\{\s*(signing_button|signing_url)\s*\}\}/.test(body)) problems.push("This template must contain {{signing_button}} or {{signing_url}}");
  if (["intake_invitation", "intake_reminder"].includes(key) && !/\{\{\s*(form_button|form_url)\s*\}\}/.test(body)) problems.push("This template must contain {{form_button}} or {{form_url}}");
  return problems;
}
