import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default [
  ...next,
  ...nextTs,
  { ignores: [".next*/**", "node_modules/**", "drizzle/**", "next-env.d.ts"] },
  {
    rules: {
      // The bundled logo is an animated GIF that must ship unaltered, and signature/branding images are user blobs; next/image would re-encode both.
      "@next/next/no-img-element": "off",
      // Auth/locale/org changes deliberately do a full document load so server layouts and cookies re-evaluate.
      "@next/next/no-location-assign-relative-destination": "off",
      // Fetch-on-mount hooks (useApi, pdf loader) reset state at the start of the effect; that is the intended pattern here.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
];
