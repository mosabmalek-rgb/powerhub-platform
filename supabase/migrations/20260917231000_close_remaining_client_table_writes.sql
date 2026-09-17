-- Close remaining browser-originated table writes.
-- The application uses server-side/RPC mutation paths for these tables.
-- Keep direct DML unavailable to anon/authenticated so tenant, actor,
-- audit, idempotency and business-rule enforcement remains centralized.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.access_invitations,
  public.access_recovery_requests,
  public.audit_logs,
  public.company_account_sites,
  public.invoice_share_links,
  public.messaging_schedule_runs,
  public.mobile_api_sessions,
  public.mobile_sync_events,
  public.notification_messages,
  public.offline_sync_operations,
  public.platform_access_invitations,
  public.platform_role_policies,
  public.platform_security_events,
  public.platform_security_settings,
  public.platform_settings,
  public.platform_sms_fallback_providers,
  public.platform_sms_plans,
  public.platform_tariff_policies,
  public.platform_tweetsms_accounts,
  public.platform_tweetsms_balance_alerts,
  public.site_portal_settings,
  public.sms_package_requests,
  public.subscription_upgrade_requests,
  public.tariffs,
  public.tenant_members,
  public.tenant_tweetsms_accounts,
  public.user_quick_action_preferences
FROM anon, authenticated, public;
