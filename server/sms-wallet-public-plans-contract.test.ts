import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const walletMigration = read("supabase/migrations/20261019130000_powerhub_sms_lifetime_wallet_and_public_plan_visibility.sql");
const adminWalletMigration = read("supabase/migrations/20261019140000_powerhub_sms_wallet_admin_operations.sql");
const rechargeHardeningMigration = read("supabase/migrations/20261001005000_powerhub_sms_recharge_ledger_hardening.sql");
const runtime = read("server/admin-runtime.ts");
const powerhub = read("server/powerhub.ts");
const home = read("client/src/pages/Home.tsx");
const messagingPage = read("client/src/pages/MessagingSettingsPage.tsx");
const subscriptionEditor = read("client/src/pages/AdminAdvancedWorkspace.tsx");
const adminConsole = read("client/src/pages/AdminConsolePage.tsx");
const adminLayout = read("client/src/components/PlatformAdminLayout.tsx");
const landing = read("client/src/pages/MarketingLandingPage.tsx");

describe("SMS permanent wallet and public plan visibility", () => {
  it("anchors existing tenants at cutover and new tenants at their first subscription", () => {
    expect(walletMigration).toContain("select t.id,now() from public.tenants t");
    expect(walletMigration).toContain("after insert on public.tenant_subscriptions");
    expect(walletMigration).toContain("values(new.tenant_id,coalesce(new.created_at,now())) on conflict(tenant_id) do nothing");
    expect(walletMigration).toContain("m.created_at>=coalesce(w.accounting_started_at,now())");
  });

  it("preserves approved permanent credit and repairs a linked pending ledger record in place", () => {
    expect(walletMigration).toContain("where l.request_id=r.id");
    expect(walletMigration).toContain("and r.status='approved'");
    expect(walletMigration).toContain("and l.status='pending'");
    expect(walletMigration).toContain("set status='manual_confirmed'");
    expect(walletMigration).toContain("and l.confirmed_at is not null");
    expect(walletMigration).not.toContain("powerhub_admin_grant_sms_wallet_credit");
    expect(adminWalletMigration).toContain("powerhub_admin_create_sms_recharge_request");
    expect(adminWalletMigration).toContain("powerhub_admin_confirm_sms_recharge");
  });

  it("requires explicit, idempotent server-side recharge confirmation", () => {
    expect(adminWalletMigration).toContain("powerhub_admin_create_sms_recharge_request");
    expect(adminWalletMigration).toContain("SMS_RECHARGE_REQUEST_PENDING");
    expect(adminWalletMigration).toContain("if v_site_id is null then raise exception 'SITE_NOT_FOUND'");
    expect(adminWalletMigration).toContain("insert into public.platform_security_events");
    expect(adminWalletMigration).not.toContain("insert into public.audit_logs(user_id,actor_platform_role,entity_type,entity_id,action,after_data)");
    expect(adminWalletMigration).toContain("powerhub_admin_confirm_sms_recharge");
    expect(adminWalletMigration).toContain("order by (s.status<>'archived') desc, s.id");
    expect(adminWalletMigration).toContain("SMS_RECHARGE_CREDIT_EXCEEDS_REQUEST");
    expect(adminWalletMigration).toContain("INVALID_SMS_PACKAGE_CURRENCY");
    expect(adminWalletMigration).toContain("Use the same lock order as package-request review");
    expect(adminWalletMigration).toContain("perform 1");
    expect(adminWalletMigration.indexOf("from public.sms_package_requests r")).toBeLessThan(
      adminWalletMigration.lastIndexOf("from public.tenant_sms_recharge_ledger l\n  where l.id=p_ledger_id\n  for update"),
    );
    expect(rechargeHardeningMigration).toContain("for update");
    expect(rechargeHardeningMigration).toContain("SMS_RECHARGE_ALREADY_FINALIZED");
    expect(rechargeHardeningMigration).toContain("revoke all on function public.powerhub_admin_confirm_sms_recharge");
    expect(rechargeHardeningMigration).toContain("to service_role");
  });

  it("keeps wallet balance and provider monthly usage distinct", () => {
    const claimStart = walletMigration.indexOf("CREATE OR REPLACE FUNCTION public.powerhub_claim_sms_notification");
    const claimBody = walletMigration.slice(claimStart);
    expect(walletMigration).toContain("greatest(credits.total-usage.used,0)");
    expect(claimBody).toContain("monthly_limit");
    expect(claimBody).toContain("v_used_wallet_segments");
    expect(claimBody).toContain("v_used_segments");
    expect(home).toContain("quota?.providerMonthlyLimit");
    expect(messagingPage).toContain("حد مزود الخدمة الشهري");
  });

  it("requests catalog packages by ID and has no customer-entered SMS quantity field", () => {
    expect(home).toContain("smsCreditPackages.useQuery");
    expect(home).toContain("packageId, note");
    expect(home).not.toContain("requestedMessages: messages");
    expect(home).not.toContain('name="messages"');
    expect(messagingPage).toContain("smsCreditPackages.useQuery");
    expect(messagingPage).toContain("packageId})");
    expect(messagingPage).not.toContain('name="messages"');
  });

  it("removes bundled SMS fields from subscription package persistence", () => {
    expect(subscriptionEditor).not.toContain("includedMessages: Number(form.get");
    expect(subscriptionEditor).not.toContain("smsCost: Number(form.get");
    expect(subscriptionEditor).not.toContain("smsAddons");
    expect(subscriptionEditor).toContain("export function SmsWalletAdministrationPanel");
    expect(subscriptionEditor).toContain("تأكيد الشحن");
    expect(adminConsole).toContain('tab === "smsWallet"');
    expect(adminLayout).toContain('id: "smsWallet"');
    expect(subscriptionEditor).toContain("rechargeIdempotencyKey");
    expect(subscriptionEditor).toContain("crypto.randomUUID()");
  });

  it("only returns allow-listed public subscription fields and does not resurrect disabled plans", () => {
    const start = powerhub.indexOf("publicPackageCatalog: publicProcedure.query");
    const end = powerhub.indexOf("smsQuota: protectedProcedure", start);
    const publicCatalog = powerhub.slice(start, end);
    expect(publicCatalog).toContain("const packageSource: Array<Record<string, unknown>>");
    expect(publicCatalog).toContain(": fallback.packages");
    expect(publicCatalog).toContain("A configured, intentionally empty/all-disabled catalog stays empty.");
    expect(publicCatalog).toContain("addons: {}");
    expect(publicCatalog).not.toContain("{ ...item }");
    expect(publicCatalog).not.toContain("message: catalog.message");
    expect(publicCatalog).not.toContain("grossProfit");
    expect(publicCatalog).not.toContain("serviceNet");
    expect(publicCatalog).not.toContain("originalPrice");
  });

  it("guards public-plan visibility with server settings and preserves other landing-page sections", () => {
    expect(runtime).toContain("savePlatformSettingSupabase");
    expect(subscriptionEditor).toContain("export function PublicPlanVisibilityPanel");
    expect(landing).toContain("catalog.data?.showPlans !== false");
    expect(landing).toContain('{showPlans ? <a href="#plans"');
    expect(landing).toContain('{showPlans ? <a href="#plans" className="hover:text-[#F5B800]">الباقات</a> : null}');
    expect(landing).toContain('{showPlans ? <section id="plans"');
    expect(landing).toContain('<section id="contact"');
    expect(landing).not.toContain("رسالة SMS");
  });
});
