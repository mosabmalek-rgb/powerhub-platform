-- PowerHub subscriber lifecycle: suspended is operationally blocked but quota-consuming; archived is excluded from quota/search.
alter table public.subscribers
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id bigint,
  add column if not exists purge_after_at timestamptz,
  add column if not exists purge_started_at timestamptz;

create index if not exists subscribers_active_tenant_site_idx
  on public.subscribers(tenant_id,site_id,created_at desc)
  where archived_at is null;

create index if not exists subscribers_archive_retention_idx
  on public.subscribers(tenant_id,site_id,purge_after_at,id)
  where archived_at is not null;

alter table public.invoices alter column subscriber_id drop not null;
alter table public.payments alter column subscriber_id drop not null;
alter table public.invoices drop constraint if exists invoices_subscriber_id_fkey;
alter table public.invoices add constraint invoices_subscriber_id_fkey
  foreign key(subscriber_id) references public.subscribers(id) on delete set null;
alter table public.payments drop constraint if exists payments_subscriber_id_fkey;
alter table public.payments add constraint payments_subscriber_id_fkey
  foreign key(subscriber_id) references public.subscribers(id) on delete set null;

create or replace function public.powerhub_change_subscriber_lifecycle(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_subscriber_id bigint,p_action text,p_client_operation_id uuid
) returns table(subscriber_id bigint,action text,service_status text,archived_at timestamptz,purge_after_at timestamptz,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_s public.subscribers%rowtype; v_response jsonb; v_limit integer; v_count integer; v_now timestamptz:=now(); v_before_status text; v_before_archived timestamptz;
begin
 if p_action not in ('suspend','activate','archive','restore') then raise exception 'INVALID_SUBSCRIBER_LIFECYCLE_ACTION'; end if;
 if p_client_operation_id is not null then
   perform pg_advisory_xact_lock(hashtext('subscriber-lifecycle:'||p_user_id||':'||p_client_operation_id));
   select response into v_response from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id::text limit 1;
   if found then
     if not exists(select 1 from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id::text and tenant_id=p_tenant_id and site_id=p_site_id and operation_type='subscriber_lifecycle' and entity_id=p_subscriber_id) then raise exception 'SUBSCRIBER_OPERATION_SCOPE_CONFLICT'; end if;
     return query select (v_response->>'subscriberId')::bigint,v_response->>'action',v_response->>'serviceStatus',nullif(v_response->>'archivedAt','')::timestamptz,nullif(v_response->>'purgeAfterAt','')::timestamptz,true; return;
   end if;
 end if;
 perform pg_advisory_xact_lock(case when p_action in('archive','restore') then p_tenant_id else p_subscriber_id end);
 select * into v_s from public.subscribers where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
 if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE'; end if;
 if v_s.purge_started_at is not null then raise exception 'SUBSCRIBER_PURGE_IN_PROGRESS'; end if;
 v_before_status:=v_s.service_status; v_before_archived:=v_s.archived_at;
 if p_action='suspend' then
   if v_s.archived_at is not null then raise exception 'SUBSCRIBER_ARCHIVED'; end if;
   if v_s.service_status='suspended' then raise exception 'SUBSCRIBER_ALREADY_SUSPENDED'; end if;
   update public.subscribers set service_status='suspended',updated_at=v_now where id=v_s.id; v_s.service_status:='suspended';
 elsif p_action='activate' then
   if v_s.archived_at is not null then raise exception 'SUBSCRIBER_ARCHIVED'; end if;
   if v_s.service_status='active' then raise exception 'SUBSCRIBER_ALREADY_ACTIVE'; end if;
   update public.subscribers set service_status='active',updated_at=v_now where id=v_s.id; v_s.service_status:='active';
 elsif p_action='archive' then
   if v_s.archived_at is not null then raise exception 'SUBSCRIBER_ALREADY_ARCHIVED'; end if;
   update public.subscribers set archived_at=v_now,archived_by_user_id=p_user_id,purge_after_at=v_now+interval '60 days',purge_started_at=null,updated_at=v_now where id=v_s.id;
   v_s.archived_at:=v_now; v_s.purge_after_at:=v_now+interval '60 days';
 elsif p_action='restore' then
   if v_s.archived_at is null then raise exception 'SUBSCRIBER_NOT_ARCHIVED'; end if;
   select count(*)::integer into v_count from public.subscribers where tenant_id=p_tenant_id and archived_at is null and id<>p_subscriber_id;
   v_limit:=public.powerhub_effective_tenant_quota(p_tenant_id,'subscribers');
   if v_count>=v_limit then raise exception 'SUBSCRIBER_QUOTA_REACHED'; end if;
   update public.subscribers set archived_at=null,archived_by_user_id=null,purge_after_at=null,purge_started_at=null,service_status='active',updated_at=v_now where id=v_s.id;
   v_s.archived_at:=null; v_s.purge_after_at:=null; v_s.service_status:='active';
 end if;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'subscriber',p_subscriber_id::text,'lifecycle_'||p_action,
   jsonb_build_object('serviceStatus',v_before_status,'archivedAt',v_before_archived),
   jsonb_build_object('serviceStatus',v_s.service_status,'archivedAt',v_s.archived_at,'purgeAfterAt',v_s.purge_after_at,'action',p_action));
 if p_client_operation_id is not null then
   insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
   values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'subscriber_lifecycle','subscriber',p_subscriber_id,
     jsonb_build_object('subscriberId',p_subscriber_id,'action',p_action,'serviceStatus',v_s.service_status,'archivedAt',v_s.archived_at,'purgeAfterAt',v_s.purge_after_at));
 end if;
 return query select p_subscriber_id,p_action,v_s.service_status,v_s.archived_at,v_s.purge_after_at,false;
end $$;

revoke all on function public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid) from public;
grant execute on function public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid) to service_role;

create or replace function public.powerhub_claim_expired_subscribers(p_limit integer default 50)
returns table(subscriber_id bigint,tenant_id bigint,site_id bigint)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 return query with c as (
   select id from public.subscribers where archived_at is not null and purge_after_at is not null and purge_after_at<=now() and purge_started_at is null
   order by purge_after_at,id for update skip locked limit greatest(1,least(coalesce(p_limit,50),100))
 ) update public.subscribers s set purge_started_at=now(),updated_at=now() from c where s.id=c.id returning s.id,s.tenant_id,s.site_id;
end $$;
revoke all on function public.powerhub_claim_expired_subscribers(integer) from public;
grant execute on function public.powerhub_claim_expired_subscribers(integer) to service_role;

create or replace function public.powerhub_reset_subscriber_purge_claim(p_subscriber_id bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin update public.subscribers set purge_started_at=null,updated_at=now() where id=p_subscriber_id and archived_at is not null; return found; end $$;
revoke all on function public.powerhub_reset_subscriber_purge_claim(bigint) from public;
grant execute on function public.powerhub_reset_subscriber_purge_claim(bigint) to service_role;

create or replace function public.powerhub_finalize_expired_subscriber_purge(p_subscriber_id bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rids bigint[];
begin
 perform pg_advisory_xact_lock(p_subscriber_id);
 if not exists(select 1 from public.subscribers where id=p_subscriber_id and archived_at is not null and purge_started_at is not null and purge_after_at<=now()) then return false; end if;
 select coalesce(array_agg(id),'{}'::bigint[]) into v_rids from public.meter_readings where subscriber_id=p_subscriber_id;
 delete from public.payment_documentation_requests where subscriber_id=p_subscriber_id or invoice_id in(select id from public.invoices where subscriber_id=p_subscriber_id);
 delete from public.invoice_share_links where invoice_id in(select id from public.invoices where subscriber_id=p_subscriber_id);
 delete from public.notification_messages where subscriber_id=p_subscriber_id or invoice_id in(select id from public.invoices where subscriber_id=p_subscriber_id);
 delete from public.complaints where subscriber_id=p_subscriber_id;
 delete from public.meters where subscriber_id=p_subscriber_id;
 delete from public.meter_readings where subscriber_id=p_subscriber_id;
 delete from public.audit_logs where (entity_type='subscriber' and entity_id=p_subscriber_id::text) or (entity_type='meter_reading' and array_length(v_rids,1) is not null and entity_id=any(v_rids::text[]));
 delete from public.offline_sync_operations where entity_type in('subscriber','meter_reading') and entity_id=p_subscriber_id;
 delete from public.subscribers where id=p_subscriber_id;
 return true;
end $$;
revoke all on function public.powerhub_finalize_expired_subscriber_purge(bigint) from public;
grant execute on function public.powerhub_finalize_expired_subscriber_purge(bigint) to service_role;
