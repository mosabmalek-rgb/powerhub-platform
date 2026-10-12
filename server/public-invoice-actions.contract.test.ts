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
    expect(billing).toContain("openWindowSafely(");
    expect(billing).toContain("window.location.origin");
    expect(billing).toContain("result.path");
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
    expect(server).toContain('admin.rpc("powerhub_cycle_for_reading"');
    expect(server).toContain("paymentDocumentationGazaDateBoundary");
    expect(server).toContain('if (input.status !== "all") query = query.eq("status", input.status)');
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
});
