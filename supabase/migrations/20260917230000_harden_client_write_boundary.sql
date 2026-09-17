-- Harden the browser write boundary.
-- Business-state mutations must go through server-side RPCs so authorization,
-- tenant/site scope, audit, idempotency and concurrency checks stay centralized.
-- Generator synchronization keeps its dedicated authenticated RPC surface,
-- but direct table writes remain disabled.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE
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
  FROM anon, authenticated, public;

-- users contains authority-bearing columns (role, platform_role,
-- account_status). Browser clients must use server-side profile/admin flows.
DROP POLICY IF EXISTS users_self_update ON public.users;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.users
  FROM anon, authenticated, public;
