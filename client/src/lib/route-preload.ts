const routePreloaders: Record<string, () => Promise<unknown>> = {
  "/subscribers": () => import("../pages/NetworkDirectoryPage"),
  "/generators": () => import("../pages/NetworkDirectoryPage"),
  "/readings": () => import("../pages/MeterReadingsPage"),
  "/invoices": () => import("../pages/BillingPage"),
  "/collections": () => import("../pages/OperationsPage"),
  "/expenses": () => import("../pages/OperationsPage"),
  "/reports": () => import("../pages/ReportsPage"),
  "/notifications": () => import("../pages/MessagingSettingsPage"),
  "/audit": () => import("../pages/AuditLogPage"),
  "/settings": () => import("../pages/SettingsPage"),
  "/staff": () => import("../pages/SettingsPage"),
  "/branches": () => import("../pages/BranchesPage"),
};

export function preloadRoute(path: string) {
  void routePreloaders[path]?.();
}
