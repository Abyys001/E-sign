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
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

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
    }];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
