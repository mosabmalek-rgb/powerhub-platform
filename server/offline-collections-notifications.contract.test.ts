import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const subscriberDirectory = readFileSync(resolve(process.cwd(), "client/src/pages/NetworkDirectoryPage.tsx"), "utf8");
const offlineQueue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
const operationsPage = readFileSync(resolve(process.cwd(), "client/src/pages/OperationsPage.tsx"), "utf8");
const notificationCenter = readFileSync(resolve(process.cwd(), "client/src/components/NotificationCenter.tsx"), "utf8");
const subscriberRouter = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const queryCache = readFileSync(resolve(process.cwd(), "client/src/lib/offline-query-cache.ts"), "utf8");
const main = readFileSync(resolve(process.cwd(), "client/src/main.tsx"), "utf8");
const billingPage = readFileSync(resolve(process.cwd(), "client/src/pages/BillingPage.tsx"), "utf8");
const lifecycleMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261026120000_powerhub_trial_subscription_lifecycle.sql"), "utf8");
const fieldSyncMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261020175000_powerhub_field_sync_notification_contract_fix.sql"), "utf8");
const notificationMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261020170000_powerhub_unified_notifications.sql"), "utf8");
const authController = readFileSync(resolve(process.cwd(), "client/src/_core/hooks/useAuth.ts"), "utf8");
const loginPage = readFileSync(resolve(process.cwd(), "client/src/pages/LoginPage.tsx"), "utf8");
const adminRuntime = readFileSync(resolve(process.cwd(), "server/admin-runtime.ts"), "utf8");
const paymentDocumentationPage = readFileSync(resolve(process.cwd(), "client/src/pages/PaymentDocumentationPage.tsx"), "utf8");
const dashboardPage = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");
const dashboardReads = readFileSync(resolve(process.cwd(), "server/powerhub-supabase.ts"), "utf8").split("export async function getSupabaseDashboardSummary(siteId: number, tenantId: number) {")[1]?.split("function objectValue(value: unknown)")[0] ?? "";
const meterReadingsPage = readFileSync(resolve(process.cwd(), "client/src/pages/MeterReadingsPage.tsx"), "utf8");

describe("PowerHub offline collection, opening-reading, and notification contracts", () => {
  it("removes the redundant payment-documentation notice without changing the submit action", () => {
    expect(paymentDocumentationPage).not.toContain("المشترك والفاتورة مصدرهما رابط الفاتورة الموثوق");
    expect(paymentDocumentationPage).toContain("إرسال للتحقق");
  });

  it("keeps dashboard KPI queries fresh in memory and avoids duplicate full summary reads", () => {
    expect(dashboardPage).toContain("dashboard.summary.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword), staleTime: 30_000 })");
    expect(dashboardPage).toContain("dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: selectedScope }, { enabled: Boolean(isAuthenticated && siteId && canViewFinancialOverview && !user?.mustChangePassword), staleTime: 60_000 })");
    expect(dashboardPage).toContain("staleTime: 30_000,");
    expect(dashboardReads).toContain("const [subscriberRows, generatorRows, invoiceRows, expenseRows] = await Promise.all([");
    expect(dashboardReads).not.toContain("const [subscriberResult, generatorResult, invoiceResult, expenseResult]");
    expect(meterReadingsPage).toContain('dashboard.financialOverview.invalidate({ siteId: refreshSiteId, scope: "branch" })');
    expect(meterReadingsPage).toContain('dashboard.periodMetrics.invalidate({ siteId: refreshSiteId, scope: "branch" })');
    expect(dashboardReads).not.toContain(".select(\"id, service_status\", { count: \"exact\" })");
  });

  it("queues a subscriber with an opening reading as one idempotent subscriber operation", () => {
    expect(offlineQueue).toContain("openingReading?: string");
    expect(offlineQueue).toContain("openingReadingImageData?: string");
    expect(subscriberDirectory).toContain("} else if (base.openingReading)");
    expect(subscriberDirectory).toContain('kind: "subscriber_create"');
    expect(subscriberDirectory).toContain("openingReading: base.openingReading");
    expect(subscriberDirectory).toContain("openingReadingImageData: base.openingReadingImageData");
    // Opening-reading creates must use the server's atomic opening-baseline RPC and must not
    // carry a reserved-number claim that the offline-number RPC intentionally rejects.
    expect(subscriberDirectory).toContain("It allocates the authoritative subscriber number during sync");
    expect(subscriberRouter).toContain('"powerhub_create_subscriber_with_opening_reading"');
    expect(subscriberRouter).toContain("p_opening_reading_approved: Boolean(input.openingReading)");
  });

  it("merges subscriber search and selection into one ranked smart picker", () => {
    expect(operationsPage).toContain('aria-label="البحث واختيار المشترك للتحصيل"');
    expect(operationsPage).toContain('role="combobox"');
    expect(operationsPage).toContain('role="listbox"');
    expect(operationsPage).toContain("const chooseSubscriber = (subscriberId: number)");
    expect(operationsPage).toContain(".replace(/[أإآٱ]/g, \"ا\")");
    expect(operationsPage).toContain(".replace(/[٠-٩]/g");
    expect(operationsPage).toContain("return words.every((word) => {");
    expect(operationsPage).toContain("normalizedPhone.replace(");
    expect(operationsPage).not.toContain('<Field label="بحث المشترك"><input aria-label="بحث المشترك للتحصيل"');
  });

  it("renders offline draft sync and collection sessions after the collection module", () => {
    const renderStart = operationsPage.indexOf('{section === "collections" && <><CollectionsModule');
    expect(renderStart).toBeGreaterThan(-1);
    const collectionsRender = operationsPage.slice(renderStart);
    const collectionIndex = collectionsRender.indexOf("<CollectionsModule");
    const syncIndex = collectionsRender.indexOf("<OfflineWorkSyncPanel");
    const sessionsIndex = collectionsRender.indexOf("<CollectorSessionsPanel");
    expect(collectionIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBe(-1);
    expect(sessionsIndex).toBeGreaterThan(collectionIndex);
    expect(billingPage).not.toContain("<OfflineWorkSyncPanel");
    expect(readFileSync(resolve(process.cwd(), "client/src/pages/OfflineSyncPage.tsx"), "utf8")).toContain("<OfflineWorkSyncPanel siteId={siteId} userId={user.id} />");
  });

  it("queues network-ambiguous collection sends with the original operation ID", () => {
    expect(operationsPage).toContain("clientOperationId: payload.clientOperationId ?? crypto.randomUUID()");
    expect(operationsPage).toContain("clientOperationId: completePayload.clientOperationId");
    expect(operationsPage).toContain("failed to fetch|networkerror|network request failed");
    expect(operationsPage).toContain("const queued = await queueDraft()");
    expect(operationsPage).toContain("manualDiscountAmount");
  });

  it("refreshes bell sources frequently and marks only visible unread items on opening", () => {
    expect(notificationCenter).toContain("refetchInterval:15000");
    expect(notificationCenter).toContain('supabase.channel("powerhub-notifications-"');
    expect(notificationCenter).toContain("const visibleUnread=items.filter(item=>!item.read)");
    expect(notificationCenter).toContain("setMarkVisiblePending(true)");
    expect(notificationCenter).toContain("powerhub_notification_mark_read");
    expect(notificationCenter).toContain("markChatNotificationRead");
    expect(notificationCenter).toContain("markAnnouncementRead.mutateAsync");
  });

  it("starts the selected paid package only after trial and honors the selected duration", () => {
    expect(lifecycleMigration).toContain("trial_ends_at timestamptz");
    expect(lifecycleMigration).toContain("p_site_code text, p_subscription_duration integer, p_package_code text DEFAULT");
    expect(lifecycleMigration).toContain("make_interval(months=>p_subscription_duration)");
    expect(lifecycleMigration).toContain("make_interval(years=>p_subscription_duration)");
    expect(lifecycleMigration).toContain("trial_ends_at <= now()");
    expect(lifecycleMigration).toContain("powerhub-subscription-lifecycle");
    expect(lifecycleMigration).toContain("subscription-trial-ending:");
    expect(lifecycleMigration).toContain("subscription-ending:");
    expect(adminRuntime).toContain("p_subscription_duration: normalized.subscriptionDuration");
  });

  it("creates immediate database notifications for payment documentation and field-app readings", () => {
    expect(notificationMigration).toContain("powerhub_notify_payment_documentation_request_after_insert");
    expect(notificationMigration).toContain("powerhub_notify_field_sync_received_after_insert");
    expect(notificationMigration).toContain("payment_documentation_request");
    expect(fieldSyncMigration).toContain("new.event_type <> 'sync_cycle'");
    expect(fieldSyncMigration).toContain("'field_readings_received'");
    expect(notificationCenter).toContain('supabase.channel("powerhub-notifications-"');
    expect(notificationCenter).toContain("invalidateQueries({queryKey:[...EVENT_QUERY_KEY,userId]})");
  });

  it("keeps login in-app and makes logout independent from slow device-release networking", () => {
    expect(loginPage).toContain('setLocation("/workspace")');
    expect(loginPage).not.toContain('window.location.assign("/workspace")');
    expect(loginPage).toContain("if (networkFailure)");
    expect(loginPage).toContain("getValidOfflineAuthLease()");
    expect(authController).toContain("setTimeout(resolve, 1_000)");
    expect(authController).toContain("setIsLoggingOut(false)");
  });

  it("keeps the offline cache scoped and bounded without caching financial or access-sensitive data", () => {
    expect(queryCache).toContain("OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER = 200");
    expect(queryCache).toContain("OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024");
    expect(queryCache).toContain('const BLOCKED_PROCEDURES = new Set([');
    expect(queryCache).toContain('"payments"');
    expect(queryCache).toContain('"admin"');
    expect(queryCache).toContain("record.userId !== userId");
    expect(main).toContain('staleTime: 30_000');
    expect(main).toContain("refetchOnReconnect: true");
  });
});
