const routePreloaders: Record<string, () => Promise<unknown>> = {
  "/subscribers": () => import("../pages/NetworkDirectoryPage"),
  "/generators": () => import("../pages/NetworkDirectoryPage"),
  "/readings": () => import("../pages/MeterReadingsPage"),
  "/invoices": () => import("../pages/BillingPage"),
  "/collections": () => import("../pages/OperationsPage"),
  "/expenses": () => import("../pages/OperationsPage"),
  "/inventory": () => import("../pages/InventoryWorkspacePage"),
  "/reports": () => import("../pages/ReportsPage"),
  "/notifications": () => import("../pages/MessagingSettingsPage"),
  "/audit": () => import("../pages/AuditLogPage"),
  "/settings": () => import("../pages/SettingsPage"),
  "/staff": () => import("../pages/SettingsPage"),
  "/branches": () => import("../pages/BranchesPage"),
  "/workspace": () => import("../pages/Home"),
  "/quick-actions": () => import("../pages/QuickActionsPage"),
  "/profile": () => import("../pages/ProfileSecurityPage"),
  "/support-chat": () => import("../pages/SupportChatPage"),
  "/ai-support": () => import("../pages/AiAssistantPage"),
  "/announcements": () => import("../pages/AnnouncementsPage"),
  "/mobile-sync": () => import("../pages/MobileSyncPage"),
  "/offline-sync": () => import("../pages/OfflineSyncPage"),
  "/portal-settings": () => import("../pages/SubscriberPortalSettingsPage"),
  "/human-resources": () => import("../pages/HumanResourcesWorkspacePage"),
  "/payroll": () => import("../pages/PayrollPage"),
  "/attendance": () => import("../pages/AttendancePage"),
  "/company-accounts": () => import("../pages/CompanyAccountsPage"),
  "/financial-dashboard": () => import("../pages/FinancialDashboardPage"),
  "/financial-settlements": () => import("../pages/FinancialSettlementsPage"),
  "/payment-documentation": () => import("../pages/PaymentDocumentationPage"),
  "/payment-documentation/review": () => import("../pages/PaymentDocumentationReviewPage"),
};

const WORKSPACE_ROUTE_PATHS = Object.keys(routePreloaders).filter((path) => path !== "/workspace");
let workspaceRoutesPreloaded = false;

export function preloadRoute(path: string) {
  void routePreloaders[path]?.();
}

export function preloadWorkspaceRoutes() {
  if (workspaceRoutesPreloaded) return;
  workspaceRoutesPreloaded = true;
  for (const path of WORKSPACE_ROUTE_PATHS) preloadRoute(path);
}
