import { defineConfig } from "vitest/config";
import path from "node:path";
import { loadEnvFile } from "node:process";

try { loadEnvFile(".env"); } catch { /* CI provides env directly */ }

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["tests/**/*.test.ts"], fileParallelism: false, testTimeout: 20000 },
});
