import { preloadRoute } from "./lib/route-preload";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import { lazy, Suspense } from "react";
const OfflineStatusBanner = lazy(() => import("@/components/OfflineStatusBanner").then((module) => ({ default: module.OfflineStatusBanner })));
const RouteAccessGate = lazy(() => import("@/components/RouteAccessGate").then((module) => ({ default: module.RouteAccessGate })));
const Home = lazy(() => import("./pages/Home"));
const WorkspaceHome = lazy(() => import("./pages/Home").then((module) => ({ default: module.WorkspaceHome })));
const LoginPage = lazy(() => import("./pages/LoginPage"));
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
const OperationsPage = lazy(() => import("./pages/OperationsPage"));
const InventoryWorkspacePage = lazy(() => import("./pages/InventoryWorkspacePage"));
const MeterReadingsPage = lazy(() => import("./pages/MeterReadingsPage"));
const BillingPage = lazy(() => import("./pages/BillingPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const NetworkDirectoryPage = lazy(() => import("./pages/NetworkDirectoryPage"));
const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const FinancialDashboardPage = lazy(() => import("./pages/FinancialDashboardPage"));
const FinancialSettlementsPage = lazy(() => import("./pages/FinancialSettlementsPage"));
const CompanyAccountsPage = lazy(() => import("./pages/CompanyAccountsPage"));
const MessagingSettingsPage = lazy(() => import("./pages/MessagingSettingsPage"));
const AuditLogPage = lazy(() => import("./pages/AuditLogPage"));
import PublicInvoice from "./pages/PublicInvoice";
const AdminConsolePage = lazy(() => import("./pages/AdminConsolePage"));
const FinanceAdminPage = lazy(() => import("./pages/FinanceAdminPage"));
const ProfileSecurityPage = lazy(() => import("./pages/ProfileSecurityPage"));
const SubscriberPortalPage = lazy(() => import("./pages/SubscriberPortalPage"));
const SubscriberAccountStatementPage = lazy(() => import("./pages/SubscriberAccountStatementPage"));
const SubscriberPortalSettingsPage = lazy(() => import("./pages/SubscriberPortalSettingsPage"));
const BranchesPage = lazy(() => import("./pages/BranchesPage"));
const HumanResourcesPage = lazy(() => import("./pages/HumanResourcesPage"));
const PayrollPage = lazy(() => import("./pages/PayrollPage"));
const AttendancePage = lazy(() => import("./pages/AttendancePage"));
const MobileSyncPage = lazy(() => import("./pages/MobileSyncPage"));
const MobileReadingDetailPage = lazy(() => import("./pages/MobileReadingDetailPage"));
const QuickActionsPage = lazy(() => import("./pages/QuickActionsPage"));
const OfflineSyncPage = lazy(() => import("./pages/OfflineSyncPage"));
const SetupWizardPage = lazy(() => import("./pages/SetupWizardPage"));
const TrialSubscriptionManagementPage = lazy(() => import("./pages/TrialSubscriptionManagementPage"));
const SupportChatPage = lazy(() => import("./pages/SupportChatPage"));
const AiAssistantPage = lazy(() => import("./pages/AiAssistantPage"));
const SupportCenterPage = lazy(() => import("./pages/SupportCenterPage"));
const PaymentDocumentationPage = lazy(() => import("./pages/PaymentDocumentationPage"));
const PaymentDocumentationReviewPage = lazy(() => import("./pages/PaymentDocumentationReviewPage"));
const PlatformAnnouncementsPage = lazy(() => import("./pages/PlatformAnnouncementsPage"));
const AdminGeneratorFeaturesPage = lazy(() => import("./pages/AdminGeneratorFeaturesPage"));
const AdminOwnerSubscriptionProfilePage = lazy(() => import("./pages/AdminOwnerSubscriptionProfilePage"));
const AnnouncementsPage = lazy(() => import("./pages/AnnouncementsPage"));
const NotificationsCenterPage = lazy(() => import("./pages/NotificationsCenterPage"));

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/login"} component={LoginPage} />
      <Route path={"/workspace"} component={WorkspaceHome} />
      <Route path={"/setup"}>{() => <RouteAccessGate><SetupWizardPage /></RouteAccessGate>}</Route>
      <Route path={"/quick-actions"}>{() => <RouteAccessGate><QuickActionsPage /></RouteAccessGate>}</Route>
      <Route path={"/profile"}>{() => <RouteAccessGate><ProfileSecurityPage /></RouteAccessGate>}</Route>
      <Route path={"/support-chat"}>{() => <RouteAccessGate><SupportChatPage /></RouteAccessGate>}</Route>
      <Route path={"/ai-support"}>{() => <RouteAccessGate><AiAssistantPage /></RouteAccessGate>}</Route>
      <Route path={"/support-center"}>{() => <RouteAccessGate><SupportCenterPage /></RouteAccessGate>}</Route>
      <Route path={"/invoice/:token"} component={PublicInvoice} />
      <Route path={"/portal"} component={SubscriberPortalPage} />
      <Route path={"/subscriber-statement/:subscriberId"}>{() => <RouteAccessGate><SubscriberAccountStatementPage /></RouteAccessGate>}</Route>
      <Route path={"/portal-settings"}>{() => <RouteAccessGate><SubscriberPortalSettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/branches"}>{() => <RouteAccessGate><BranchesPage /></RouteAccessGate>}</Route>
      <Route path={"/subscribers"}>{() => <RouteAccessGate><NetworkDirectoryPage kind="subscribers" /></RouteAccessGate>}</Route>
      <Route path={"/generators"}>{() => <RouteAccessGate><NetworkDirectoryPage kind="generators" /></RouteAccessGate>}</Route>
      <Route path={"/readings"}>{() => <RouteAccessGate><MeterReadingsPage /></RouteAccessGate>}</Route>
      <Route path={"/invoices"}>{() => <RouteAccessGate><BillingPage /></RouteAccessGate>}</Route>
      <Route path={"/collections"}>{() => <RouteAccessGate><OperationsPage section="collections" /></RouteAccessGate>}</Route>
      <Route path={"/expenses"}>{() => <RouteAccessGate><OperationsPage section="expenses" /></RouteAccessGate>}</Route>
      <Route path={"/inventory"}>{() => <RouteAccessGate><InventoryWorkspacePage /></RouteAccessGate>}</Route>
      <Route path={"/reports"}>{() => <RouteAccessGate><ReportsPage /></RouteAccessGate>}</Route>
      <Route path={"/financial-dashboard"}>{() => <RouteAccessGate><FinancialDashboardPage /></RouteAccessGate>}</Route>
      <Route path={"/financial-settlements"}>{() => <RouteAccessGate><FinancialSettlementsPage /></RouteAccessGate>}</Route>
      <Route path={"/payment-documentation/public/:token"} component={PaymentDocumentationPage} />
      <Route path={"/payment-documentation/review"}>{() => <RouteAccessGate><PaymentDocumentationReviewPage /></RouteAccessGate>}</Route>
      <Route path={"/payment-documentation"}>{() => <RouteAccessGate><PaymentDocumentationPage /></RouteAccessGate>}</Route>
      <Route path={"/company-accounts"}>{() => <RouteAccessGate><CompanyAccountsPage /></RouteAccessGate>}</Route>
      <Route path={"/notifications"}>{() => <RouteAccessGate><MessagingSettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/announcements"}>{() => <RouteAccessGate><AnnouncementsPage /></RouteAccessGate>}</Route>
      <Route path={"/notifications-center"}>{() => <RouteAccessGate><NotificationsCenterPage /></RouteAccessGate>}</Route>
      <Route path={"/audit"}>{() => <RouteAccessGate><AuditLogPage /></RouteAccessGate>}</Route>
      <Route path={"/mobile-sync/readings/:readingId"}>{() => <RouteAccessGate><MobileReadingDetailPage /></RouteAccessGate>}</Route>
      <Route path={"/mobile-sync"}>{() => <RouteAccessGate><MobileSyncPage /></RouteAccessGate>}</Route>
      <Route path={"/offline-sync"}>{() => <RouteAccessGate><OfflineSyncPage /></RouteAccessGate>}</Route>
      <Route path={"/settings"}>{() => <RouteAccessGate><SettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/staff"}>{() => <RouteAccessGate><SettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/human-resources"}>{() => <RouteAccessGate><HumanResourcesPage /></RouteAccessGate>}</Route>
      <Route path={"/payroll"}>{() => <RouteAccessGate><PayrollPage /></RouteAccessGate>}</Route>
      <Route path={"/attendance"}>{() => <RouteAccessGate><AttendancePage /></RouteAccessGate>}</Route>
      <Route path={"/admin/trial-management"}>{() => <RouteAccessGate platformAdminOnly><TrialSubscriptionManagementPage /></RouteAccessGate>}</Route>
      <Route path={"/admin/owner-subscriptions/:tenantId"}>{() => <RouteAccessGate platformAdminOnly><AdminOwnerSubscriptionProfilePage /></RouteAccessGate>}</Route>
      <Route path={"/admin/generator-features/:tenantId"}>{() => <RouteAccessGate platformAdminOnly><AdminGeneratorFeaturesPage /></RouteAccessGate>}</Route>
      <Route path={"/admin/generator-features"}>{() => <RouteAccessGate platformAdminOnly><AdminGeneratorFeaturesPage /></RouteAccessGate>}</Route>
      <Route path={"/admin/announcements"}>{() => <RouteAccessGate platformAdminOnly><PlatformAnnouncementsPage /></RouteAccessGate>}</Route>
      <Route path={"/admin"}>{() => <RouteAccessGate><AdminConsolePage /></RouteAccessGate>}</Route>
      <Route path={"/finance-admin"}>{() => <RouteAccessGate financeAdminOnly><FinanceAdminPage /></RouteAccessGate>}</Route>
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const standalonePublicInvoice = typeof window !== "undefined" && /^\/invoice\/[^/]+\/?$/.test(window.location.pathname);
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Toaster />
          {!standalonePublicInvoice ? <Suspense fallback={null}><OfflineStatusBanner /></Suspense> : null}
          <Suspense fallback={<div className="grid min-h-screen place-items-center bg-background text-foreground">جارٍ تحميل الصفحة…</div>}><Router /></Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
