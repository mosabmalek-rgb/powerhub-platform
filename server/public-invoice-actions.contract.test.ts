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
    expect(migration).toContain("create or replace function public.powerhub_submit_public_payment_documentation");
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
