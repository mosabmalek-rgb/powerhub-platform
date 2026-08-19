import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import FeaturePage from "./pages/FeaturePage";
import OperationsPage from "./pages/OperationsPage";
import MeterReadingsPage from "./pages/MeterReadingsPage";
import BillingPage from "./pages/BillingPage";
import SettingsPage from "./pages/SettingsPage";
import NetworkDirectoryPage from "./pages/NetworkDirectoryPage";
import ReportsPage from "./pages/ReportsPage";
import MessagingSettingsPage from "./pages/MessagingSettingsPage";
import AuditLogPage from "./pages/AuditLogPage";
import PublicInvoice from "./pages/PublicInvoice";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/invoice/:token"} component={PublicInvoice} />
      <Route path={"/subscribers"}>{() => <NetworkDirectoryPage kind="subscribers" />}</Route>
      <Route path={"/generators"}>{() => <NetworkDirectoryPage kind="generators" />}</Route>
      <Route path={"/readings"} component={MeterReadingsPage} />
      <Route path={"/invoices"} component={BillingPage} />
      <Route path={"/collections"}>{() => <OperationsPage section="collections" />}</Route>
      <Route path={"/expenses"}>{() => <OperationsPage section="expenses" />}</Route>
      <Route path={"/reports"} component={ReportsPage} />
      <Route path={"/notifications"} component={MessagingSettingsPage} />
      <Route path={"/audit"} component={AuditLogPage} />
      <Route path={"/map"}>{() => <FeaturePage section="map" />}</Route>
      <Route path={"/settings"} component={SettingsPage} />
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
        defaultTheme="dark"
        // switchable
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
