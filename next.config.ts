import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const dev = process.env.NODE_ENV !== "production";

// No third-party origins: fonts, scripts, PDF worker and images are all first-party. `blob:` is for the pdf.js worker and canvas previews only.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:", // spoken answers of the AI Accountant are played from a blob: URL
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Public payment pages host Stripe's embedded checkout: Stripe.js, its iframes and API calls must come from Stripe (PCI).
const STRIPE = "https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://*.stripe.com https://*.stripe.network";
const payCsp = csp
  .replace("script-src 'self'", `script-src 'self' ${STRIPE}`)
  .replace("img-src 'self'", "img-src 'self' https://*.stripe.com")
  .replace("connect-src 'self'", `connect-src 'self' ${STRIPE}`)
  .replace("form-action 'self'", `form-action 'self' ${STRIPE}`)
  .concat(`; frame-src ${STRIPE}`);

const config: NextConfig = {
  // A second instance (e.g. an e2e run) can use its own build directory without clobbering a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  agentRules: false,
  poweredByHeader: false,
  serverExternalPackages: ["pdfkit", "pg", "pg-boss", "@node-rs/argon2", "@cantoo/pdf-lib", "nodemailer", "sanitize-html"],
  outputFileTracingIncludes: { "/**": ["./assets/**/*", "./public/brand/*"] },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
      ],
    }, {
      // Finance pages: the AI Accountant may use the microphone (this site only; the browser still asks the user).
      source: "/accounting/:path*",
      headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" }],
    }, {
      // Payment links: embedded Stripe checkout (Apple Pay / Google Pay need the Payment Request API inside Stripe's frame).
      source: "/pay/:path*",
      headers: [
        { key: "Content-Security-Policy", value: payCsp },
        { key: "Permissions-Policy", value: `camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com" "https://checkout.stripe.com")` },
      ],
    }];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
