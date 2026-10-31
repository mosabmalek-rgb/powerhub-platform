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
    include: [
      "client/src/pages/role-guards.ui.test.tsx",
      "client/src/pages/LoginPage.ui.test.tsx",
      "client/src/pages/BillingPage.test.tsx",
      "client/src/pages/OperationsPage.test.tsx",
      "client/src/pages/SettingsPage.test.tsx",
      "client/src/pages/QuickActionsPage.ui.test.tsx",
      "client/src/pages/WorkspaceHome.smsQuota.ui.test.tsx",
      "client/src/pages/PlatformAccessPanel.ui.test.tsx",
      "client/src/pages/TenantAccessInvitationPanel.ui.test.tsx",
      "client/src/pages/collection-form-reset.contract.test.ts",
    ],
  },
});
