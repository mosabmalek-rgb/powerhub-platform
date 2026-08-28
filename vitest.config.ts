import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // Keep the suite hermetic: client modules that build a Supabase client at
    // import time need these to be defined, and tests must never depend on a
    // developer's local .env file.
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY:
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "test-publishable-key",
    },
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "client/src/**/*.test.{ts,tsx}", "shared/**/*.test.ts"],
  },
});
