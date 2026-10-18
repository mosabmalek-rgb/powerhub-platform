import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import PublicInvoice from "@/pages/PublicInvoice";

/**
 * Minimal provider shell for the public invoice route.
 * Keep the workspace router and its broad route-preload graph out of this
 * entry so report/chart modules remain lazy until a workspace route is used.
 */
export default function PublicInvoiceApp() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark" switchable={false}>
        <TooltipProvider>
          <Toaster />
          <PublicInvoice />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
