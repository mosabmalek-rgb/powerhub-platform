-- Per-site invoice due interval in hours. Existing day-based policies are preserved.
alter table public.sites add column if not exists invoice_due_hours integer;

update public.sites
set invoice_due_hours = greatest(1, least(2160, coalesce(invoice_due_days, 14) * 24))
where invoice_due_hours is null;

alter table public.sites alter column invoice_due_hours set default 336;
alter table public.sites alter column invoice_due_hours set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sites'::regclass
      and conname = 'sites_invoice_due_hours_range'
  ) then
    alter table public.sites
      add constraint sites_invoice_due_hours_range check (invoice_due_hours between 1 and 2160);
  end if;
end
$$;

create or replace function public.powerhub_save_site_invoice_due_hours(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_invoice_due_hours integer
)
returns table(invoice_due_hours integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_allowed boolean;
  v_before jsonb;
  v_actor_platform_role text;
  v_actor_tenant_role text;
begin
  if p_invoice_due_hours is null or p_invoice_due_hours < 1 or p_invoice_due_hours > 2160 then
    raise exception 'INVALID_INVOICE_DUE_HOURS' using errcode = 'P0001';
  end if;

  select
    exists (
      select 1 from public.users u
      where u.id = p_user_id and u.account_status = 'active'
        and u.platform_role in ('platform_owner','platform_admin','finance_admin')
    )
    or exists (
      select 1 from public.tenant_members m
      where m.tenant_id = p_tenant_id and m.user_id = p_user_id
        and m.is_active and m.membership_status = 'active' and m.role = 'owner'
    )
    or exists (
      select 1 from public.tenant_members m
      join public.staff_profiles s
        on s.user_id = m.user_id and s.tenant_id = m.tenant_id
        and s.site_id = p_site_id and s.is_active
      where m.tenant_id = p_tenant_id and m.user_id = p_user_id
        and m.is_active and m.membership_status = 'active' and s.role = 'owner'
        and (s.suspension_ends_at is null or s.suspension_ends_at <= now())
    )
  into v_allowed;

  if not v_allowed then
    raise exception 'INVOICE_DUE_POLICY_PERMISSION_REQUIRED' using errcode = 'P0001';
  end if;

  select u.platform_role into v_actor_platform_role
  from public.users u
  where u.id = p_user_id and u.account_status = 'active';

  select m.role into v_actor_tenant_role
  from public.tenant_members m
  where m.tenant_id = p_tenant_id and m.user_id = p_user_id
    and m.is_active and m.membership_status = 'active';

  select to_jsonb(s) into v_before
  from public.sites s
  where s.id = p_site_id and s.tenant_id = p_tenant_id
  for update;

  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001'; end if;

  update public.sites
  set invoice_due_hours = p_invoice_due_hours, updated_at = now()
  where id = p_site_id and tenant_id = p_tenant_id;

  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_tenant_role, entity_type, entity_id, action, before_data, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_actor_platform_role, v_actor_tenant_role, 'site_invoice_due_policy', p_site_id::text, 'configure',
    v_before, jsonb_build_object('invoiceDueHours', p_invoice_due_hours)
  );

  return query select p_invoice_due_hours;
end;
$$;

revoke execute on function public.powerhub_save_site_invoice_due_hours(bigint,bigint,bigint,integer) from public, anon, authenticated;
grant execute on function public.powerhub_save_site_invoice_due_hours(bigint,bigint,bigint,integer) to service_role;

-- Keep older day-based branch edits and the new hour-based settings in sync.
-- If both values are supplied, the explicitly changed field determines the result.
create or replace function public.powerhub_sync_invoice_due_interval()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $
begin
  if new.invoice_due_days is distinct from old.invoice_due_days
     and new.invoice_due_hours is not distinct from old.invoice_due_hours then
    new.invoice_due_hours := greatest(1, least(2160, new.invoice_due_days * 24));
  elsif new.invoice_due_hours is distinct from old.invoice_due_hours
     and new.invoice_due_days is not distinct from old.invoice_due_days then
    new.invoice_due_days := greatest(1, least(90, ceil(new.invoice_due_hours::numeric / 24)::integer));
  end if;
  return new;
end;
$;

drop trigger if exists powerhub_sync_legacy_invoice_due_days_trigger on public.sites;
drop trigger if exists powerhub_sync_invoice_due_interval_trigger on public.sites;
create trigger powerhub_sync_invoice_due_interval_trigger
before update of invoice_due_days, invoice_due_hours on public.sites
for each row execute function public.powerhub_sync_invoice_due_interval();
