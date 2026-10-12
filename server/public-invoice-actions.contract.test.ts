import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("public invoice and inquiry actions", () => {
  it("labels invoice link action as copy and copies directly instead of opening native share UI", () => {
    const billing = read("client/src/pages/BillingPage.tsx");
    expect(billing).toContain("نسخ رابط الفاتورة");
    expect(billing).toContain("copyTextSafely(url)");
    expect(billing).not.toContain("navigator.share({ title: \"فاتورة PowerHub\"");
    expect(billing).toContain("إظهار الفاتورة");
    expect(billing).toContain("openWindowSafely(`${window.location.origin}${result.path}`)");
  });

  it("gates inquiry payment documentation by the owner's effective feature entitlement and invoice balance", () => {
    const server = read("server/powerhub.ts");
    const portal = read("client/src/pages/SubscriberPortalPage.tsx");
    expect(server).toContain('rpc("powerhub_payment_documentation_access"');
    expect(server).toContain("paymentDocumentationAvailable,");
    expect(portal).toContain("portalData.paymentDocumentationAvailable");
    expect(portal).toContain("Number(invoice.balanceDue) > 0");
    expect(portal).toContain('shareInvoice.useMutation');
    expect(portal).toContain("/payment-documentation/public/");
  });

  it("uses the entitled subscriber inquiry logo for public invoices and falls back to the platform logo", () => {
    const server = read("server/powerhub.ts");
    const invoice = read("client/src/pages/PublicInvoice.tsx");
    expect(server).toContain('rpc("powerhub_subscriber_portal_logo_access"');
    expect(server).toContain('from("site_portal_settings").select("logo_key")');
    expect(invoice).toContain('companyLogoUrl');
    expect(invoice).toContain('<PowerHubLogo size="invoice" className="justify-center" />');
    expect(server).toContain('select("company_name")');
    expect(server).toContain("companyName =");
  });

  it("creates a short-lived invoice share link only after server-side public inquiry verification", () => {
    const server = read("server/powerhub.ts");
    const migration = read("supabase/migrations/20261012130000_powerhub_portal_invoice_share_link.sql");
    expect(server).toContain('rpc("powerhub_create_portal_invoice_share_link"');
    expect(server).toContain("getVerifiedPortalInvoice(input)");
    expect(migration).toContain("powerhub_subscriber_portal_invoice(");
    expect(migration).toContain("now()+interval '7 days'");
    expect(migration).toContain("grant execute on function public.powerhub_create_portal_invoice_share_link");
    const payloadMigration = read("supabase/migrations/20261012130500_powerhub_shared_invoice_scope_payload.sql");
    expect(payloadMigration).toContain("'siteId',v_invoice.site_id");
    expect(payloadMigration).toContain("'tenantId',v_link.tenant_id");
    expect(payloadMigration).toContain("grant execute on function public.powerhub_get_shared_invoice_by_token_hash(text)");
  });
});
