import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("public invoice and inquiry actions", () => {
  it("labels invoice link action as copy and copies directly instead of opening native share UI", () => {
    const billing = read("client/src/pages/BillingPage.tsx");
    expect(billing).toContain("نسخ رابط الفاتورة");
    expect(billing).toContain("copyTextSafely(url)");
    expect(billing).not.toContain('navigator.share({ title: "فاتورة PowerHub"');
    expect(billing).toContain("إظهار الفاتورة");
    expect(billing).toContain("setPreviewInvoiceUrl");
    expect(billing).toContain("<iframe title=\"معاينة الفاتورة\"");
    expect(billing).toContain("<Dialog open={previewInvoiceOpen}");
    expect(billing).toContain("setPreviewInvoiceOpen(true); updatePreviewStatus(\"loading\"); openInvoice.mutate");
    expect(billing).toContain("جارٍ تجهيز رابط الفاتورة…");
    expect(billing).not.toContain("openWindowSafely(");
    expect(billing).toContain("window.location.origin");
    expect(billing).toContain("result.path");
  });

  it("allows same-origin framing only for shared invoice previews", () => {
    const config = JSON.parse(read("vercel.json")) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
      functions: Record<string, { regions?: string[] }>;
    };
    const general = config.headers.find((rule) => rule.source === "/:path((?!invoice/)(?!invoice\\.html$).*)");
    const invoice = config.headers.find((rule) => rule.source === "/invoice/:token");
    expect(general?.headers.find((header) => header.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'none'");
    expect(general?.headers.find((header) => header.key === "X-Frame-Options")?.value).toBe("DENY");
    expect(invoice?.headers.find((header) => header.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'self'");
    expect(invoice?.headers.find((header) => header.key === "X-Frame-Options")?.value).toBe("SAMEORIGIN");
    expect(config.functions["api/[...path].js"].regions).toEqual(["sin1"]);
  });

  it("bounds public invoice loading and returns a retryable iframe error instead of an endless spinner", () => {
    const publicInvoice = read("client/src/pages/PublicInvoice.tsx");
    const server = read("server/powerhub.ts");
    const telemetry = read("server/performance-telemetry.ts");
    const billing = read("client/src/pages/BillingPage.tsx");
    expect(publicInvoice).toContain("16_000");
    expect(publicInvoice).toContain("تعذر تحميل الفاتورة الآن");
    expect(publicInvoice).toContain("void invoiceQuery.refetch()");
    expect(publicInvoice).toContain("powerhub-public-invoice-status");
    expect(server).toContain("create_link_rpc_attempt_");
    expect(server).toContain("invoices.createShareLink");
    expect(server).toContain("site_authorization");
    expect(server).toContain("5_000");
    expect(server).toContain("shared_invoice_lookup_rpc");
    expect(server).toContain("8_000");
    expect(server).toContain("parallel_branding_entitlement_queries");
    expect(server).toContain("2_500");
    expect(telemetry).toContain("controller.abort()");
    expect(billing).toContain('previewInvoiceStatus === "error"');
    expect(billing).toContain("إعادة المحاولة");
    expect(billing).toContain("event.source !== previewIframeRef.current?.contentWindow");
    expect(billing).toContain("powerhub-public-invoice-parent-ready");
    expect(billing).toContain("window.setInterval(() =>");
    expect(billing).toContain("}, 18_000);");
    expect(billing).toContain("durationMs: startedAt === null ? 18_000");
    expect(publicInvoice).toContain("powerhub-public-invoice-parent-ready");
    expect(publicInvoice).toContain("event.source !== window.parent");

    const main = read("client/src/main.tsx");
    const app = read("client/src/App.tsx");
    expect(main).toContain('const App = lazy(() => import("./App"))');
    expect(main).not.toContain('import("./PublicInvoiceApp")');
    const invoiceHtml = read("client/invoice.html");
    const invoiceMain = read("client/src/invoice-main.tsx");
    expect(invoiceHtml).toContain('src="/src/invoice-main.tsx"');
    expect(invoiceMain).toContain('import PublicInvoiceApp from "./PublicInvoiceApp"');
    expect(invoiceMain).not.toContain('from "./App"');
    const publicInvoiceApp = read("client/src/PublicInvoiceApp.tsx");
    expect(publicInvoiceApp).toContain('import PublicInvoice from "@/pages/PublicInvoice"');
    expect(publicInvoiceApp).not.toContain('from "./App"');
    expect(publicInvoiceApp).not.toContain('from "@/lib/route-preload"');
    expect(main).not.toContain('import App from "./App"');
    expect(main).toContain("if (isStandalonePublicInvoiceRoute()) return {};");
    // Protected routes wait for bounded local-cache hydration inside the app
    // bootstrap gate; standalone invoice links bypass that gate immediately.
    expect(main).toContain("if (standalonePublicInvoice) return;");
    expect(main).toContain("Promise.race([bootstrapOfflineState(), deadline])");
    expect(main.indexOf("Promise.race([bootstrapOfflineState(), deadline])")).toBeLessThan(main.indexOf("<AuthProvider>"));
    expect(main).toContain("renderApp();");
    expect(main).not.toContain("bootstrapOfflineState().finally(renderApp)");
    const transientSignOutStart = main.indexOf("// A transient SDK SIGNED_OUT");
    const transientSignOutEnd = main.indexOf("if (!nextUserId)", transientSignOutStart);
    expect(transientSignOutStart).toBeGreaterThanOrEqual(0);
    expect(transientSignOutEnd).toBeGreaterThan(transientSignOutStart);
    const transientSignOut = main.slice(transientSignOutStart, transientSignOutEnd);
    expect(transientSignOut).toContain("if (lease) await activateUser(lease.userId);");
    expect(transientSignOut).not.toContain("activateUser(lease?.userId ?? null)");
    expect(main).toContain('register("/sw.js?v=7")');
    const sw = read("client/public/sw.js");
    const main = read("client/src/main.tsx");
    expect(sw).toContain('const SHELL_CACHE = "powerhub-shell-v8"');
    expect(sw).toContain('const ASSET_CACHE = "powerhub-assets-v7"');
    expect(sw).not.toContain("NAVIGATION_TIMEOUT_MS");
    expect(sw).not.toContain("fetchWithTimeout");
    expect(sw).toContain('fetch(request, { cache: "no-store" })');
    expect(main).toContain('navigator.serviceWorker.register("/sw.js?v=8")');
    expect(sw).toContain("isPublicInvoiceNavigation(url)");
    expect(sw.indexOf('if (request.mode === "navigate" && isPublicInvoiceNavigation(url)) return;')).toBeLessThan(sw.indexOf('if (request.mode === "navigate") {'));
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).toContain('"report-pdf": ["html2canvas", "jspdf"]');
    expect(viteConfig).toContain('charts: ["recharts"]');
    expect(viteConfig).toContain('const invoiceOnlyBuild = process.env.POWERHUB_INVOICE_ONLY === "1"');
    expect(viteConfig).toContain("emptyOutDir: !invoiceOnlyBuild");
    expect(viteConfig).toContain('? path.resolve(PROJECT_ROOT, "client", "invoice.html")');
    const buildScript = read("scripts/build-production.mjs");
    expect(buildScript).toContain('run(["exec", "vite", "build"], { POWERHUB_INVOICE_ONLY: "1" });');
    expect(buildScript).toContain('path.join(outputDirectory, "invoice.html")');
    const config = JSON.parse(read("vercel.json")) as { rewrites: Array<{ source: string; destination: string }>; headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    const invoiceRewriteIndex = config.rewrites.findIndex((rewrite) => rewrite.source === "/invoice/:token" && rewrite.destination === "/invoice.html");
    const fallbackRewriteIndex = config.rewrites.findIndex((rewrite) => rewrite.source === "/(.*)");
    expect(invoiceRewriteIndex).toBeGreaterThanOrEqual(0);
    expect(invoiceRewriteIndex).toBeLessThan(fallbackRewriteIndex);
    expect(config.headers.find((rule) => rule.source === "/invoice/:token")?.headers.find((header) => header.key === "Cache-Control")?.value).toBe("no-store, max-age=0");
    expect(config.headers.find((rule) => rule.source === "/invoice.html")?.headers.find((header) => header.key === "X-Frame-Options")?.value).toBe("SAMEORIGIN");
    expect(config.headers.find((rule) => rule.source === "/invoice.html")?.headers.find((header) => header.key === "Cache-Control")?.value).toBe("no-store, max-age=0");
    expect(config.headers.find((rule) => rule.source === "/:path((?!invoice/)(?!invoice\\.html$).*)")).toBeDefined();
    expect(app).toContain('const Home = lazy(() => import("./pages/Home"))');
    expect(app).toContain('const RouteAccessGate = lazy(() => import("@/components/RouteAccessGate")');
    expect(app).toContain('const LoginPage = lazy(() => import("./pages/LoginPage"))');
  });

  it("opens invoice preview as an overlay dialog without navigating away or opening a new tab", () => {
    const billing = read("client/src/pages/BillingPage.tsx");
    expect(billing).toContain("const [previewInvoiceUrl, setPreviewInvoiceUrl] = useState<string | null>(null)");
    expect(billing).toContain("setPreviewInvoiceUrl(`${window.location.origin}${result.path}`)");
    expect(billing).toContain("const [previewInvoiceOpen, setPreviewInvoiceOpen] = useState(false)");
    expect(billing).toContain("<Dialog open={previewInvoiceOpen} onOpenChange={(open) => { setPreviewInvoiceOpen(open); if (!open) { setPreviewInvoiceUrl(null); updatePreviewStatus(\"loading\"); } }}>");
    expect(billing).toContain("setPreviewInvoiceOpen(true); updatePreviewStatus(\"loading\"); openInvoice.mutate");
    expect(billing).toContain("جارٍ تجهيز رابط الفاتورة…");
    expect(billing).toContain("<iframe title=\"معاينة الفاتورة\"");
    expect(billing).toContain("تظهر الفاتورة هنا فوق الصفحة الحالية");
  });

  it("explains every attendance add/update field and the report date filters", () => {
    const attendance = read("client/src/pages/AttendancePage.tsx");
    for (const label of ["الموظف", "تاريخ الدوام", "الساعات الاعتيادية", "الساعات الإضافية", "أيام الغياب", "ملاحظات (اختياري)"]) {
      expect(attendance).toContain(label);
    }
    for (const description of ["اختيار الموظف نفسه مع تاريخ مسجل يحدّث سجل ذلك اليوم", "القيمة الافتراضية 8 ساعات", "ربع ساعة", "نصف يوم", "سبب الغياب", "فلاتر التقرير: حدّد تاريخ البداية والنهاية"]) {
      expect(attendance).toContain(description);
    }
  });

  it("checks report-only dependencies from the actual invoice module script, not the HTML manifest key", () => {
    const build = read("scripts/build-production.mjs");
    expect(build).toContain('html.matchAll(/<script[^>]*>/gi)');
    expect(build).toContain("tag.includes('type=\"module\"')");
    expect(build).toContain("record.file === entryFile");
    expect(build).toContain("entryRecord.imports ?? []");
    expect(build).toContain("Keep PDF, chart and spreadsheet dependencies behind dynamic imports.");
  });

  it("checks the pending public payment-documentation request before enabling the invoice action", () => {
    const server = read("server/powerhub.ts");
    const invoice = read("client/src/pages/PublicInvoice.tsx");
    const migration = read("supabase/migrations/20261018143000_powerhub_payment_documentation_context_lines_fast_read.sql");
    expect(server).toContain("publicStatus: publicProcedure.input");
    expect(server).toContain('rpc("powerhub_get_public_payment_documentation_status"');
    expect(server).toContain('rpc("powerhub_get_public_payment_documentation_context"');
    expect(migration).toContain("from public.invoice_share_links");
    const statusStart = migration.indexOf("create or replace function public.powerhub_get_public_payment_documentation_status");
    const statusFunction = migration.slice(statusStart);
    expect(statusFunction).toContain("'hasPendingSubmission', v_has_pending");
    expect(statusFunction).toContain("v_has_pending := found");
    expect(invoice).toContain('await import("@/lib/report-pdf")');
    expect(invoice).toContain("powerhub.paymentDocumentation.publicStatus.useQuery");
    expect(invoice).toContain("paymentStatusQuery.data?.hasPendingSubmission");
    expect(invoice).toContain("paymentStatusQuery.isFetching");
    expect(invoice).toContain("paymentStatusQuery.isError ?");
    expect(invoice).toContain("paymentStatusQuery.refetch()");
    expect(invoice).toContain("تم إرسال التوثيق — بانتظار المراجعة");
    expect(invoice).toContain("downloadReportHtmlAsPdf(invoiceElement");
    expect(invoice).toContain("تحميل PDF");
  });

  it("uses the receiver account type as the collection method and awaits expense creation before resetting the form", () => {
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(operations).toContain('name="method" value={selectedCompanyAccount?.accountType ?? ""}');
    expect(operations).not.toContain('name="method" value={collectionMethod}');
    expect(operations).toContain("onSubmit={addExpense.mutateAsync}");
    expect(operations).toContain("await onSubmit({ siteId, generatorId:");
    expect(operations).toContain("form.reset();");
    expect(operations).toContain("جارٍ حفظ المصروف...");
  });

  it("gates public inquiry payment documentation by entitlement and outstanding balance", () => {
    const server = read("server/powerhub.ts");
    const portal = read("client/src/pages/SubscriberPortalPage.tsx");
    const publicInvoice = read("client/src/pages/PublicInvoice.tsx");
    const paymentPage = read("client/src/pages/PaymentDocumentationPage.tsx");
    expect(server).toContain('rpc("powerhub_payment_documentation_access"');
    expect(server).toContain("paymentDocumentationAvailable,");
    expect(publicInvoice).toContain('!["draft", "cancelled", "paid"].includes(String(invoice.status).toLowerCase())');
    expect(paymentPage).toContain('!["draft", "cancelled", "paid"].includes(String(invoice?.status ?? "").toLowerCase())');
    expect(portal).toContain("portalData.paymentDocumentationAvailable");
    expect(portal).toContain("Number(invoice.balanceDue) > 0");
    expect(portal).toContain('!["draft", "cancelled", "paid"].includes(String(invoice.status).toLowerCase())');
    expect(portal).toContain("shareInvoice.useMutation");
    expect(portal).toContain("/payment-documentation/public/");
  });

  it("registers public payment documentation route without an authenticated route gate", () => {
    const app = read("client/src/App.tsx");
    const publicRoute = '<Route path={"/payment-documentation/public/:token"} component={PaymentDocumentationPage} />';
    expect(app).toContain('const PaymentDocumentationPage = lazy(() => import("./pages/PaymentDocumentationPage"));');
    expect(app).toContain(publicRoute);
    expect(app.indexOf(publicRoute)).toBeLessThan(app.indexOf('<Route path={"/payment-documentation/review"}>'));
    expect(app).toContain('<Route path={"/invoice/:token"} component={PublicInvoice} />');
  });

  it("hides public payment documentation for paid, draft, and cancelled invoices", () => {
    const publicInvoice = read("client/src/pages/PublicInvoice.tsx");
    const portal = read("client/src/pages/SubscriberPortalPage.tsx");
    const paymentPage = read("client/src/pages/PaymentDocumentationPage.tsx");
    for (const source of [publicInvoice, portal, paymentPage]) {
      expect(source).toContain('"draft", "cancelled", "paid"');
      expect(source).toContain("balanceDue");
    }
  });

  it("keeps payment-documentation approval atomic with payment, collection, invoice balance, and audit", () => {
    const approvalMigration = read("supabase/migrations/20260920200000_powerhub_payment_documentation_receipt_retention.sql");
    const paymentMigration = read("supabase/migrations/0014_powerhub_create_payment_rpc.sql");
    const server = read("server/powerhub.ts");

    expect(server).toContain('rpc("powerhub_approve_payment_documentation"');
    expect(approvalMigration).toContain("create or replace function public.powerhub_approve_payment_documentation");
    expect(approvalMigration).toContain("from public.powerhub_create_payment(");
    expect(approvalMigration).toContain("set status='approved'");
    expect(approvalMigration).toContain("payment_id=v_payment_id");
    expect(approvalMigration).toContain("insert into public.audit_logs");
    expect(paymentMigration).toContain("insert into public.payments");
    expect(paymentMigration).toContain("insert into public.account_transactions");
    expect(paymentMigration).toContain("'collection'");
    expect(paymentMigration).toContain("update public.invoices");
    expect(paymentMigration).toContain("actor_platform_role");
  });

  it("keeps platform and tenant audit roles separate in payment approval migrations", () => {
    const paymentMigration = read("supabase/migrations/20261012170000_powerhub_payment_documentation_audit_role_fix.sql");

    expect(paymentMigration).toContain("create or replace function public.powerhub_create_payment");
    expect(paymentMigration).toContain("create or replace function public.powerhub_approve_payment_documentation");
    expect(paymentMigration).toContain("create or replace function public.powerhub_reject_payment_documentation");
    expect(paymentMigration).toContain("left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id");
    expect(paymentMigration).toContain("actor_platform_role,actor_tenant_role");
    expect(paymentMigration).toContain("if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;");
    expect(paymentMigration).toContain("insert into public.account_transactions");
    expect(paymentMigration).toContain("'collection'");
    expect(paymentMigration).toContain("update public.invoices");
  });

  it("does not write public visitors into the constrained platform audit role", () => {
    const migration = read("supabase/migrations/20261012183000_powerhub_public_payment_documentation_audit_role_fix.sql");

    expect(migration.toLowerCase()).toContain("create or replace function public.powerhub_submit_public_payment_documentation");
    expect(migration).toContain("v_link.tenant_id, v_invoice.site_id, null, null,");
    expect(migration).toContain("'submissionSource', 'public_invoice_share_link'");
    expect(migration).not.toContain("null, 'public',");
  });

  it("uses the entitled subscriber portal logo and falls back to the platform logo", () => {
    const server = read("server/powerhub.ts");
    const invoice = read("client/src/pages/PublicInvoice.tsx");
    expect(server).toContain('rpc("powerhub_subscriber_portal_logo_access"');
    expect(server).toContain('from("site_portal_settings").select("logo_key")');
    expect(invoice).toContain("companyLogoUrl");
    expect(invoice).toContain('<PowerHubLogo size="invoice" className="justify-center" />');
    expect(server).toContain('select("company_name")');
    expect(server).toContain("companyName =");
  });

  it("repairs the public payment-documentation RPC bridge with matching account scope and phone validation", () => {
    const migration = read("supabase/migrations/20261012131500_powerhub_public_payment_documentation_bridge_repair.sql");
    const server = read("server/powerhub.ts");

    expect(migration).toContain("create or replace function public.powerhub_get_public_payment_documentation_context");
    expect(migration.toLowerCase()).toContain("create or replace function public.powerhub_submit_public_payment_documentation");
    expect(migration).toContain("revoke all on function public.powerhub_get_public_payment_documentation_context(text)");
    expect(migration).toContain("grant execute on function public.powerhub_get_public_payment_documentation_context(text) to service_role");
    expect(migration).toContain("grant execute on function public.powerhub_submit_public_payment_documentation(text, bigint, numeric, text, text, text, text, text, uuid) to service_role");
    expect(migration).toContain("alter column submitted_by_user_id drop not null");
    expect(migration).toContain("if v_account_has_site_mappings and not exists");
    expect(migration).toContain("v_sender_phone !~");
    expect(migration).toContain("[0-9]{7,20}");
    expect(server).toContain("regex(/^");
    expect(server).toContain("[0-9]{7,20}");
  });

  it("allows differing electronic source and destination providers while preserving cash account restrictions", () => {
    const migration = read("supabase/migrations/20261012190000_powerhub_payment_documentation_source_destination_type_support.sql");
    expect(migration).toContain("public.powerhub_create_payment");
    expect(migration).toContain("public.powerhub_submit_payment_documentation");
    expect(migration).toContain("public.powerhub_submit_public_payment_documentation");
    expect(migration).toContain("(p_payment_method='cash' and v_account.account_type<>'cash')");
    expect(migration).toContain("(p_payment_method<>'cash' and v_account.account_type='cash')");
    expect(migration).not.toContain("p_payment_method='jawwal_pay' and v_account.account_type<>'jawwal_pay'");
    const internalRestore = read("supabase/migrations/20261012191000_powerhub_payment_documentation_internal_submit_restore.sql");
    expect(internalRestore).toContain("if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash')");
    expect(internalRestore).toContain("from public, anon, authenticated");
  });

  it("shows full destination-account identity and offers a scoped receipt preview", () => {
    const page = read("client/src/pages/PaymentDocumentationPage.tsx");
    const review = read("client/src/pages/PaymentDocumentationReviewPage.tsx");
    const server = read("server/powerhub.ts");
    expect(page).toContain("اسم الحساب: {selectedAccount.name}");
    expect(page).toContain("نوع الحساب المستقبِل: {accountTypeLabel(selectedAccount.accountType)}");
    expect(page).toContain("الرقم المرتبط بالحساب: {selectedAccount.phoneNumber");
    expect(review).toContain("عرض صورة التحويل");
    expect(review).toContain("destination_account_name");
    expect(review).toContain("destination_account_phone_number");
    expect(server).toContain("storageGetSignedUrl(data.receipt_image_key)");
    expect(server).toContain('.eq("tenant_id", access.tenantId).eq("site_id", input.siteId)');
  });

  it("supports time filters in all payment-documentation review statuses", () => {
    const review = read("client/src/pages/PaymentDocumentationReviewPage.tsx");
    const server = read("server/powerhub.ts");
    for (const label of ["هذه الدورة", "اليوم", "يوم محدد", "فترة زمنية محددة", "كل الفترات"]) {
      expect(review).toContain(label);
    }
    expect(server).toContain('period: z.enum(["current_cycle","today","specific_day","date_range","all_time"])');
    expect(server).toContain('supabaseAdmin().rpc("powerhub_cycle_for_reading"');
    expect(server).toContain("paymentDocumentationGazaDateBoundary");
    expect(server).toContain('if (input.status !== "all") query = query.eq("status", input.status)');
    expect(review).toContain('if (period === "current_cycle") return false');
    expect(review).toContain("لا يمكن التحقق من مطابقة لقطة الطلبات لدورة القراءة الحالية دون اتصال");
  });

  it("filters collections by canonical cycle, receiver account type/account, and exports readable destination columns", () => {
    const operations = read("client/src/pages/OperationsPage.tsx");
    const server = read("server/powerhub.ts");
    expect(server).toContain("currentBounds: protectedProcedure.input(siteScoped)");
    expect(server).toContain('admin.rpc("powerhub_cycle_for_reading"');
    for (const label of ["اليوم", "هذه الدورة", "آخر الشهر", "مخصص", "نوع الحساب المستقبل", "الحساب المستقبل"]) {
      expect(operations).toContain(label);
    }
    expect(operations).toContain("paymentReceiverType");
    expect(operations).toContain("paymentReceiverAccountId");
    expect(operations).toContain("اسم المولد");
    expect(operations).toContain("دورة الفوترة");
    expect(operations).toContain("نوع الحساب المحوَّل منه");
    expect(operations).toContain("الحساب المستقبل");
    expect(operations).toContain("wrapText: true");
    const finance = read("client/src/pages/FinancialDashboardPage.tsx");
    expect(finance).toContain("readingCycle.currentBounds.useQuery");
    expect(finance).toContain("REPORT_PAYMENT_METHOD_OPTIONS");
    expect(finance).toContain('paymentMethod }, { enabled: Boolean(siteId && isAuthenticated');
    expect(finance).toContain("هذه الدورة");
    expect(finance).toContain("آخر الشهر");
    expect(finance).toContain("مخصص");
    expect(server).toContain("paymentMethod: z.string().optional()");
    expect(server).toContain("payment.paymentMethod === input.paymentMethod");
  });

  it("opens payment-documentation receipts in a compact dialog instead of expanding each review card", () => {
    const review = read("client/src/pages/PaymentDocumentationReviewPage.tsx");
    expect(review).toContain('import { Dialog, DialogContent, DialogHeader, DialogTitle }');
    expect(review).toContain("openReceiptPreview");
    expect(review).toContain('<Dialog open={Boolean(previewReceipt)}');
    expect(review).toContain('className="mx-auto max-h-[70vh] w-full rounded-xl border border-white/10 object-contain"');
  });

  it("keeps platform and tenant audit roles separate when the internal documentation request is submitted", () => {
    const restoreMigration = read("supabase/migrations/20261012191000_powerhub_payment_documentation_internal_submit_restore.sql");
    expect(restoreMigration).toContain("left join public.tenant_members m on m.user_id=u.id and m.tenant_id=p_tenant_id");
    expect(restoreMigration).toContain("actor_platform_role, actor_tenant_role");
    expect(restoreMigration).toContain("if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;");
  });

  it("restores the internal payment-documentation RPC and keeps its execution service-role-only", () => {
    const restoreMigration = read("supabase/migrations/20261012191000_powerhub_payment_documentation_internal_submit_restore.sql");
    expect(restoreMigration).toContain("CREATE OR REPLACE FUNCTION public.powerhub_submit_payment_documentation");
    expect(restoreMigration).toContain("grant execute on function public.powerhub_submit_payment_documentation");
    expect(restoreMigration).toContain("from public, anon, authenticated");
    expect(restoreMigration).toContain("(p_payment_method='cash' and v_account.account_type<>'cash')");
    expect(restoreMigration).toContain("(p_payment_method<>'cash' and v_account.account_type='cash')");
    expect(restoreMigration).toContain("if exists (");
    expect(restoreMigration).toContain("and not exists (");
  });

  it("makes the source/destination type migration safe for partial staging schemas and reapplication", () => {
    const migration = read("supabase/migrations/20261012190000_powerhub_payment_documentation_source_destination_type_support.sql");
    expect(migration).toContain("if v_signature is not null then");
    expect(migration).toContain("elsif position(v_new in v_definition)=0 then");
    expect(migration).toContain("v_intermediate := $intermediate$if v_account.account_type<>p_payment_method");
    expect(migration).toContain("public.powerhub_create_payment");
    expect(migration).toContain("public.powerhub_submit_public_payment_documentation");
    expect(migration).toContain("(p_payment_method<>'cash' and v_account.account_type='cash')");
  });

  it("revalidates identity, entitlement, invoice scope and balance in the database before link creation", () => {
    const server = read("server/powerhub.ts");
    const migration = read("supabase/migrations/20261012130000_powerhub_portal_invoice_share_link.sql");
    const payloadMigration = read("supabase/migrations/20261012130500_powerhub_shared_invoice_scope_payload.sql");

    expect(server).toContain('rpc("powerhub_create_portal_invoice_share_link"');
    expect(server).toContain('text.includes("PAYMENT_DOCUMENTATION_NOT_AVAILABLE")');
    expect(server).toContain('text.includes("INVOICE_ALREADY_PAID")');
    expect(migration).toContain("powerhub_subscriber_portal_invoice(");
    expect(migration).toContain("powerhub_subscriber_portal_check_rate_limit");
    expect(migration).toContain("powerhub_subscriber_portal_record_attempt");
    expect(migration).toContain("v_input_phone");
    expect(migration).toContain("'^00(970|972)(56|59)[0-9]{7}$'");
    expect(migration).toContain("public.powerhub_payment_documentation_access(v_tenant_id)");
    expect(migration).toContain("coalesce(v_invoice_balance_due, 0) <= 0");
    expect(migration).toContain("INVOICE_ALREADY_PAID");
    expect(migration).toContain("for update of invoice");
    expect(migration).toContain("hashtextextended(");
    expect(migration).toContain("'payment-documentation-invoice:'");
    expect(migration.indexOf("hashtextextended(")).toBeLessThan(migration.indexOf("for update of invoice"));
    expect(migration).toContain("now() + interval '7 days'");
    expect(migration).toContain("revoke all on function public.powerhub_create_portal_invoice_share_link");
    expect(migration).toContain("grant execute on function public.powerhub_create_portal_invoice_share_link");

    expect(payloadMigration).toContain("'siteId',v_invoice.site_id");
    expect(payloadMigration).toContain("'tenantId',v_link.tenant_id");
    expect(payloadMigration).toContain("v_link.revoked_at");
    expect(payloadMigration).toContain("view_count=view_count+1");
    expect(payloadMigration).toContain("revoke all on function public.powerhub_get_shared_invoice_by_token_hash(text)");
    expect(payloadMigration).toContain("grant execute on function public.powerhub_get_shared_invoice_by_token_hash(text)");
  });

  it("parallelizes independent payment-documentation list reads without bypassing access or site scope", () => {
    const server = read("server/powerhub.ts");
    const listStart = server.indexOf('    list: protectedProcedure.input(siteScoped.extend({', server.indexOf("paymentDocumentation: router({"));
    const listEnd = server.indexOf("    availableAccounts:", listStart);
    const list = server.slice(listStart, listEnd);

    expect(list).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation")');
    expect(list).toContain('Promise.all([');
    expect(list).toContain('requirePaymentDocumentationFeature(access.tenantId)');
    expect(list).toContain('rpc("powerhub_cycle_for_reading"');
    expect(list).toContain('eq("tenant_id", access.tenantId).eq("site_id", input.siteId)');
    expect(list).toContain('destination_accounts');
    expect(list).toContain('destination_account_site_scope');
    expect(list).toContain('Promise.all([\n        measureSlowStage("paymentDocumentation.list", "destination_accounts"');
    expect(list).toContain('measureSlowStage("paymentDocumentation.list", "destination_account_site_scope"');
  });

  it("keeps approval authoritative while parallelizing secondary receipt work and reporting enqueue failures", () => {
    const server = read("server/powerhub.ts");
    const approvalStart = server.indexOf('    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestId: z.number().int().positive() }))');
    const approvalEnd = server.indexOf("    receiptUrl:", approvalStart);
    const approval = server.slice(approvalStart, approvalEnd);
    const review = read("client/src/pages/PaymentDocumentationReviewPage.tsx");

    expect(approval).toContain('rpc("powerhub_approve_payment_documentation"');
    expect(approval).toContain('Promise.all([');
    expect(approval).toContain('"receipt_context_rpc"');
    expect(approval).toContain('"receipt_billing_policy"');
    expect(approval).toContain('rpc("powerhub_queue_payment_sms"');
    expect(approval).toContain('queue failed after approval');
    expect(approval).toContain('secondary notification processing failed after approval');
    expect(approval.indexOf('rpc("powerhub_approve_payment_documentation"')).toBeLessThan(
      approval.indexOf('"receipt_context_rpc"'),
    );
    expect(review).toContain('approve.variables?.requestId');
    expect(review).toContain("جارٍ اعتماد الدفع…");
    expect(review).toContain("disabled={reject.isPending||(approve.isPending&&Number(approve.variables?.requestId)===Number(r.id))}");
  });

  it("uses one scoped read for payment receipt context after atomic payment-documentation approval", () => {
    const server = read("server/powerhub.ts");
    const migration = read("supabase/migrations/20261015110000_powerhub_payment_receipt_context.sql");
    const approvalStart = server.indexOf('    approve: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), requestId: z.number().int().positive() }))');
    const approvalEnd = server.indexOf("    receiptUrl:", approvalStart);
    const approval = server.slice(approvalStart, approvalEnd);

    expect(approval).toContain('rpc("powerhub_approve_payment_documentation"');
    expect(approval).toContain('rpc("powerhub_payment_receipt_context"');
    expect(approval).toContain('rpc("powerhub_queue_payment_sms"');
    expect(approval).not.toContain('.from("payments")');
    expect(approval).not.toContain('.from("invoices")');
    expect(approval).not.toContain('.from("subscribers")');
    expect(approval).not.toContain('.from("tenant_payment_receipt_message_templates")');
    expect(migration).toContain("create or replace function public.powerhub_payment_receipt_context");
    expect(migration).toContain("p.tenant_id = p_tenant_id");
    expect(migration).toContain("p.site_id = p_site_id");
    expect(migration).toContain("revoke all on function public.powerhub_payment_receipt_context");
    expect(migration).toContain("grant execute on function public.powerhub_payment_receipt_context");
  });
  it("keeps subscription duration at the end and avoids needless refetches when revisiting tabs", () => {
    const main = read("client/src/main.tsx");
    const home = read("client/src/pages/Home.tsx");
    const review = read("client/src/pages/PaymentDocumentationReviewPage.tsx");
    const paymentPage = read("client/src/pages/PaymentDocumentationPage.tsx");

    expect(main).toContain("staleTime: (query) => getOfflineQueryStaleTime(query.queryKey)");
    expect(main).toContain("refetchOnReconnect: (query) => !isDeltaSyncBackedQueryKey(query.queryKey)");
    const subscriptionCard = home.indexOf("<SubscriptionRenewalDashboardCard");
    const branchPerformance = home.indexOf("{selectedScope === \"all\" && <BranchPerformanceCard");
    expect(subscriptionCard).toBeGreaterThan(branchPerformance);
    expect(subscriptionCard).toBeLessThan(home.indexOf("</div></DashboardLayout>;"));

    expect(review).toContain("staleTime:15_000");
    expect(review).toContain("refetchInterval:shouldPollRequests?15_000:false");
    expect(review).toContain('refetchOnMount:"always"');
    expect(review).toContain("refetchIntervalInBackground:false");
    expect(review).toContain('staleTime:0,refetchOnMount:"always"');
    const mobileSync = read("client/src/pages/MobileSyncPage.tsx");
    expect(mobileSync).toContain('staleTime: 15_000, refetchOnMount: "always", refetchInterval: 15_000, refetchIntervalInBackground: false');
    expect(mobileSync).toContain("events.isFetching && events.data");
    expect(mobileSync).toContain("readings.isFetching && readings.data");
    expect(home).toContain("(sitesQuery.data?.length ?? 0) > 1 && !user?.mustChangePassword");
    expect(review).toContain("requests.isLoading&&isOnline");
    expect(review).toContain("requests.isFetching && requests.data");
    expect(review).toContain("payments.page.invalidate");
    expect(review).toContain("invoices.page.invalidate");
    expect(review).toContain("dashboard.financialOverview.invalidate");
    expect(review).toContain("refreshAfterApproval()");
    expect(paymentPage).toContain("invalidatePaymentDocumentationReview");
    expect(paymentPage).toContain('staleTime: 0, refetchOnMount: "always"');
    const auth = read("client/src/_core/hooks/useAuth.ts");
    const authState = read("client/src/lib/offline-auth-state.ts");
    expect(auth).toContain("queryClient.clear()");
    expect(auth).toContain("shouldClearQueryCacheForAuthTransition");
    expect(auth).toContain("identityChanged");
    expect(authState).toContain("if (explicitLogoutRequested && !nextUserId) return true");
    expect(authState).toContain("return identityChanged && nextUserId !== null");
    const workspace = read("client/src/pages/Home.tsx");
    const login = read("client/src/pages/LoginPage.tsx");
    const authRouting = read("client/src/lib/auth-routing.ts");
    expect(workspace).toContain("shouldRedirectToLoginWhenNoSession({");
    expect(workspace).toContain("shouldShowSessionRecovery({");
    expect(workspace).not.toContain("if (!loading && !isAuthenticated && !error)");
    expect(authRouting).toContain("!state.hasSession");
    expect(authRouting).toContain("!state.hasError");
    expect(authRouting).toContain("!state.hasUser");
    expect(login).toContain("shouldRedirectToWorkspaceAfterAuthentication({");
    expect(login).not.toContain("if (hasSupabaseSession || (!authLoading && isAuthenticated))");
    expect(workspace).toContain("if (error && !user)");
    expect(workspace).toContain("تعذر استعادة جلسة الدخول");
    const routeGate = read("client/src/components/RouteAccessGate.tsx");
    expect(routeGate).toContain("shouldRedirectToLoginWhenNoSession({");
    expect(routeGate).toContain("shouldShowSessionRecovery({");
    expect(routeGate).toContain("!loading && Boolean(error) && !user");
    expect(workspace).toContain("إعادة المحاولة واستعادة البيانات");

  });

  it("surfaces billing adjustments on payment documentation and keeps status reads lightweight", () => {
    const page = read("client/src/pages/PaymentDocumentationPage.tsx");
    const settings = read("client/src/pages/SettingsPage.tsx");
    const server = read("server/powerhub.ts");
    const migration = read("supabase/migrations/20261018143000_powerhub_payment_documentation_context_lines_fast_read.sql");
    const sqlTest = read("supabase/tests/payment_documentation_context_lines_fast_read.sql");
    const publicInvoice = read("client/src/pages/PublicInvoice.tsx");
    const subscriberPortal = read("client/src/pages/SubscriberPortalPage.tsx");

    expect(page).toContain("<InvoiceLineBreakdown lines={invoice.lines} />");
    expect(page).toContain("<InvoiceLineBreakdown lines={context.lines} />");
    expect(page).toContain("isFractionalCarry");
    expect(page).toContain("line.lineType === \"discount\"");
    expect(page).toContain("Math.round(Math.abs(amount) * 100) > 0");
    expect(page).toContain("الحساب المستقبِل");
    expect(page).toContain("طريقة/نوع حساب التحويل");
    const internalForm = page.slice(page.indexOf("بطاقة توثيق الدفع —"), page.indexOf("function PublicPaymentDocumentationView"));
    expect(internalForm.indexOf('Label className="text-slate-300">الحساب المستقبِل')).toBeLessThan(
      internalForm.indexOf('Label className="text-slate-300">طريقة/نوع حساب التحويل'),
    );
    const publicForm = page.slice(page.indexOf("function PublicPaymentDocumentationView"));
    expect(publicForm.indexOf('Label className="text-slate-300">الحساب المستقبِل')).toBeLessThan(
      publicForm.indexOf('Label className="text-slate-300">طريقة/نوع حساب التحويل'),
    );

    expect(settings).toContain("entitlementEnabled");
    expect(settings).toContain("adminStatus");
    expect(settings).toContain("paymentDocumentationAccess.isError");
    expect(settings).toContain("تعذر التحقق من الحالة");

    const statusStart = server.indexOf("publicStatus: publicProcedure");
    const contextStart = server.indexOf("publicContext: publicProcedure", statusStart);
    const statusRoute = server.slice(statusStart, contextStart);
    expect(statusRoute).toContain("powerhub_get_public_payment_documentation_status");
    expect(statusRoute).not.toContain("powerhub_get_public_payment_documentation_context");
    const publicSubmitStart = server.indexOf("publicSubmit: publicProcedure");
    const publicSubmitEnd = server.indexOf("access: protectedProcedure", publicSubmitStart);
    expect(server.slice(publicSubmitStart, publicSubmitEnd)).toContain("powerhub_get_public_payment_documentation_target");
    expect(migration).toContain("powerhub_get_public_payment_documentation_target(text)");

    const statusFunctionStart = migration.indexOf("create or replace function public.powerhub_get_public_payment_documentation_status");
    const statusFunction = migration.slice(statusFunctionStart);
    expect(statusFunction.toLowerCase()).not.toContain("for update");
    expect(statusFunction).toContain("payment_documentation_requests");
    expect(migration).toContain("'lines', v_lines");
    expect(migration).toContain("revoke all on function public.powerhub_get_public_payment_documentation_context(text) from public, anon, authenticated");
    expect(sqlTest).toContain("PAYMENT_CONTEXT_ADJUSTMENT_LINES_ASSERTION_FAILED");
    expect(sqlTest).toContain("PAYMENT_DOCUMENTATION_RPC_GRANTS_ASSERTION_FAILED");

    expect(publicInvoice).toContain("window.location.href = `/payment-documentation/public/${encodeURIComponent(token)}`");
    expect(subscriberPortal).toContain("setLocation(`/payment-documentation/public/${encodeURIComponent(token)}`)");
    expect(subscriberPortal).not.toContain("window.location.assign(`/payment-documentation/public/");
  });

});
