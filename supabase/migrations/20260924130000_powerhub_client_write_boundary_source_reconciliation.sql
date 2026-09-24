-- Source-control reconciliation for the client write boundary.
--
-- Production already contains the equivalent privilege hardening in migration
-- history (20260917205611 / 20260917205630). This forward-safe migration keeps
-- the same contract represented in Git without depending on those older,
-- currently untracked migration filenames.
--
-- The operations are idempotent and intentionally preserve service_role DML.
-- Browser-originated business mutations must use reviewed server/RPC paths.

revoke insert, update, delete, truncate on table
  public.collector_sessions,
  public.complaints,
  public.custom_permission_roles,
  public.employee_adjustments,
  public.employee_attendance,
  public.employees,
  public.generators,
  public.meter_readings,
  public.meters,
  public.sites,
  public.staff_profiles,
  public.subscribers,
  public.tenant_branch_settings,
  public.tenant_invoice_message_templates,
  public.tenant_messaging_configurations,
  public.tenant_owner_profiles,
  public.tenant_payment_receipt_message_templates,
  public.tenant_subscriptions,
  public.tenants
from public, anon, authenticated;

revoke insert, update, delete, truncate on table
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
from public, anon, authenticated;

drop policy if exists users_self_update on public.users;

revoke insert, update, delete, truncate on table public.users
from public, anon, authenticated;
