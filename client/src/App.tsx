import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RouteAccessGate } from "@/components/RouteAccessGate";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home, { WorkspaceHome } from "./pages/Home";
import OperationsPage from "./pages/OperationsPage";
import MeterReadingsPage from "./pages/MeterReadingsPage";
import BillingPage from "./pages/BillingPage";
import SettingsPage from "./pages/SettingsPage";
import NetworkDirectoryPage from "./pages/NetworkDirectoryPage";
import ReportsPage from "./pages/ReportsPage";
import FinancialDashboardPage from "./pages/FinancialDashboardPage";
import FinancialSettlementsPage from "./pages/FinancialSettlementsPage";
import CompanyAccountsPage from "./pages/CompanyAccountsPage";
import MessagingSettingsPage from "./pages/MessagingSettingsPage";
import AuditLogPage from "./pages/AuditLogPage";
import PublicInvoice from "./pages/PublicInvoice";
import AdminConsolePage from "./pages/AdminConsolePage";
import FinanceAdminPage from "./pages/FinanceAdminPage";
import LoginPage from "./pages/LoginPage";
import ProfileSecurityPage from "./pages/ProfileSecurityPage";
import SubscriberPortalPage from "./pages/SubscriberPortalPage";
import SubscriberPortalSettingsPage from "./pages/SubscriberPortalSettingsPage";
import BranchesPage from "./pages/BranchesPage";
import HumanResourcesPage from "./pages/HumanResourcesPage";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/login"} component={LoginPage} />
      <Route path={"/workspace"}>{() => <RouteAccessGate><WorkspaceHome /></RouteAccessGate>}</Route>
      <Route path={"/profile"}>{() => <RouteAccessGate><ProfileSecurityPage /></RouteAccessGate>}</Route>
      <Route path={"/invoice/:token"} component={PublicInvoice} />
      <Route path={"/portal"} component={SubscriberPortalPage} />
      <Route path={"/portal-settings"}>{() => <RouteAccessGate><SubscriberPortalSettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/branches"}>{() => <RouteAccessGate><BranchesPage /></RouteAccessGate>}</Route>
      <Route path={"/subscribers"}>{() => <RouteAccessGate><NetworkDirectoryPage kind="subscribers" /></RouteAccessGate>}</Route>
      <Route path={"/generators"}>{() => <RouteAccessGate><NetworkDirectoryPage kind="generators" /></RouteAccessGate>}</Route>
      <Route path={"/readings"}>{() => <RouteAccessGate><MeterReadingsPage /></RouteAccessGate>}</Route>
      <Route path={"/invoices"}>{() => <RouteAccessGate><BillingPage /></RouteAccessGate>}</Route>
      <Route path={"/collections"}>{() => <RouteAccessGate><OperationsPage section="collections" /></RouteAccessGate>}</Route>
      <Route path={"/expenses"}>{() => <RouteAccessGate><OperationsPage section="expenses" /></RouteAccessGate>}</Route>
      <Route path={"/reports"}>{() => <RouteAccessGate><ReportsPage /></RouteAccessGate>}</Route>
      <Route path={"/financial-dashboard"}>{() => <RouteAccessGate><FinancialDashboardPage /></RouteAccessGate>}</Route>
      <Route path={"/financial-settlements"}>{() => <RouteAccessGate><FinancialSettlementsPage /></RouteAccessGate>}</Route>
      <Route path={"/company-accounts"}>{() => <RouteAccessGate><CompanyAccountsPage /></RouteAccessGate>}</Route>
      <Route path={"/notifications"}>{() => <RouteAccessGate><MessagingSettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/audit"}>{() => <RouteAccessGate><AuditLogPage /></RouteAccessGate>}</Route>
      <Route path={"/settings"}>{() => <RouteAccessGate><SettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/staff"}>{() => <RouteAccessGate><SettingsPage /></RouteAccessGate>}</Route>
      <Route path={"/human-resources"}>{() => <RouteAccessGate><HumanResourcesPage /></RouteAccessGate>}</Route>
      <Route path={"/admin"}>{() => <RouteAccessGate platformAdminOnly><AdminConsolePage /></RouteAccessGate>}</Route>
      <Route path={"/finance-admin"}>{() => <RouteAccessGate platformAdminOnly><FinanceAdminPage /></RouteAccessGate>}</Route>
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
