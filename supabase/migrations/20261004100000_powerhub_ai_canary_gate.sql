-- Tenant-scoped PowerHub AI canary.
-- Global AI stays disabled; only an explicitly selected tenant may run the
-- server-side assistant during staged production verification.

alter table private.chat_ai_settings
  add column if not exists canary_enabled boolean not null default false,
  add column if not exists canary_tenant_id bigint null references public.tenants(id) on delete restrict;

create index if not exists chat_ai_settings_canary_tenant_idx
  on private.chat_ai_settings(canary_tenant_id)
  where canary_enabled = true;

update private.chat_ai_settings
set canary_enabled = false,
    canary_tenant_id = null
where id = true;
