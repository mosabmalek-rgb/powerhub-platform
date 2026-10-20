-- Unified in-app notifications for generator owners and platform administrators.
-- Existing chat and announcement read state remains authoritative; this table stores
-- only event notifications that need an explicit recipient and stable idempotency key.
create table if not exists public.powerhub_user_notifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  tenant_id bigint null references public.tenants(id) on delete cascade,
  notification_type text not null check (notification_type in (
    'verification_request','field_readings_received','chat_message','platform_announcement',
    'subscription_upgrade_request','sms_balance_request','payment_documentation_request',
    'security_event','system_alert'
  )),
  title text not null check (char_length(btrim(title)) between 1 and 180),
  body text not null default '' check (char_length(body) <= 1000),
  target_path text not null default '/workspace' check (target_path like '/%%' and target_path not like '//%%' and position(chr(92) in target_path) = 0),
  entity_type text null,
  entity_id text null,
  dedupe_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint powerhub_user_notifications_user_dedupe unique(user_id, dedupe_key)
);
create index if not exists powerhub_user_notifications_unread_idx
  on public.powerhub_user_notifications(user_id, created_at desc, id desc) where read_at is null;
-- Supports bounded inbox reads for both read and unread rows (not only the partial index).
create index if not exists powerhub_user_notifications_inbox_idx
  on public.powerhub_user_notifications(user_id, created_at desc, id desc);
create index if not exists powerhub_user_notifications_tenant_idx
  on public.powerhub_user_notifications(tenant_id, created_at desc, id desc);
alter table public.powerhub_user_notifications enable row level security;
revoke all on public.powerhub_user_notifications from public, anon, authenticated;
grant all on public.powerhub_user_notifications to service_role;

create or replace function public.powerhub_notification_mark_read(p_notification_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_user_id bigint;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid();
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  update public.powerhub_user_notifications n set read_at = coalesce(n.read_at, now())
   where n.id = p_notification_id and n.user_id = v_user_id;
  return found;
end;
$$;
revoke all on function public.powerhub_notification_mark_read(bigint) from public, anon;
grant execute on function public.powerhub_notification_mark_read(bigint) to authenticated;

create or replace function public.powerhub_notification_mark_all_read()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_user_id bigint; v_count integer;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid();
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  update public.powerhub_user_notifications n set read_at = now()
   where n.user_id = v_user_id and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.powerhub_notification_mark_all_read() from public, anon;
grant execute on function public.powerhub_notification_mark_all_read() to authenticated;

create or replace function public.powerhub_notification_insert(
  p_user_id bigint, p_tenant_id bigint, p_type text, p_title text, p_body text,
  p_target_path text, p_entity_type text, p_entity_id text, p_dedupe_key text,
  p_metadata jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if p_user_id is null or p_type not in (
    'verification_request','field_readings_received','chat_message','platform_announcement',
    'subscription_upgrade_request','sms_balance_request','payment_documentation_request',
    'security_event','system_alert'
  ) then raise exception 'INVALID_NOTIFICATION'; end if;
  insert into public.powerhub_user_notifications(
    user_id,tenant_id,notification_type,title,body,target_path,entity_type,entity_id,dedupe_key,metadata
  ) values (
    p_user_id,p_tenant_id,p_type,left(btrim(p_title),180),left(coalesce(p_body,''),1000),
    case
      when p_target_path like '/%' and p_target_path not like '//%'
        and position(chr(92) in p_target_path) = 0 then p_target_path
      else '/workspace'
    end,
    p_entity_type,p_entity_id,p_dedupe_key,coalesce(p_metadata,'{}'::jsonb)
  ) on conflict(user_id,dedupe_key) do nothing returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.powerhub_notification_insert(bigint,bigint,text,text,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.powerhub_notification_insert(bigint,bigint,text,text,text,text,text,text,text,jsonb) to service_role;

-- A new pending payment-documentation request notifies only the owner of its tenant.
create or replace function public.powerhub_notify_payment_documentation_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner_user_id bigint;
begin
  if tg_op <> 'INSERT' or new.status <> 'pending' then return new; end if;
  select p.owner_user_id into v_owner_user_id
    from public.tenant_owner_profiles p where p.tenant_id = new.tenant_id limit 1;
  if v_owner_user_id is not null then
    perform public.powerhub_notification_insert(
      v_owner_user_id,new.tenant_id,'payment_documentation_request',
      'طلب توثيق دفعة جديد',
      'وصل طلب توثيق دفعة للفاتورة ' || coalesce(new.invoice_no_snapshot,''),
      '/payment-documentation/review','payment_documentation_request',new.id::text,
      'payment-documentation:' || new.id::text,
      jsonb_build_object('site_id',new.site_id,'invoice_id',new.invoice_id)
    );
  end if;
  return new;
end;
$$;
drop trigger if exists powerhub_notify_payment_documentation_request_after_insert on public.payment_documentation_requests;
create trigger powerhub_notify_payment_documentation_request_after_insert
after insert on public.payment_documentation_requests
for each row execute function public.powerhub_notify_payment_documentation_request();

-- New field-app sync summaries are surfaced to the tenant owner once per event key.
create or replace function public.powerhub_notify_field_sync_received()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner_user_id bigint;
begin
  if tg_op <> 'INSERT' or new.event_type not in ('readings_sync','reading_sync','sync_readings','readings') then return new; end if;
  if coalesce(new.synced_count,0) <= 0 and coalesce(new.needs_review_count,0) <= 0 then return new; end if;
  select p.owner_user_id into v_owner_user_id
    from public.tenant_owner_profiles p where p.tenant_id = new.tenant_id limit 1;
  if v_owner_user_id is not null then
    perform public.powerhub_notification_insert(
      v_owner_user_id,new.tenant_id,'field_readings_received',
      'وصلت قراءات من التطبيق الميداني',
      'القراءات المتزامنة: ' || new.synced_count::text || '، وبانتظار المراجعة: ' || new.needs_review_count::text,
      '/mobile-sync','mobile_sync_event',new.id::text,
      'field-sync:' || new.tenant_id::text || ':' || new.event_key,
      jsonb_build_object('site_id',new.site_id,'synced_count',new.synced_count,'needs_review_count',new.needs_review_count)
    );
  end if;
  return new;
end;
$$;
drop trigger if exists powerhub_notify_field_sync_received_after_insert on public.mobile_sync_events;
create trigger powerhub_notify_field_sync_received_after_insert
after insert on public.mobile_sync_events
for each row execute function public.powerhub_notify_field_sync_received();

-- Pending upgrade requests notify platform administrators. SMS balance requests are
-- deliberately excluded here because the new permanent-wallet workflow uses its own
-- ledger and has different review semantics.
create or replace function public.powerhub_notify_admin_pending_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_admin record; v_type text; v_title text; v_path text; v_dedupe text;
begin
  if tg_op <> 'INSERT' or new.status <> 'pending' then return new; end if;
  if tg_table_name = 'subscription_upgrade_requests' then
    v_type := 'subscription_upgrade_request'; v_title := 'طلب ترقية باقة جديد'; v_path := '/admin'; v_dedupe := 'upgrade-request:' || new.id::text;
  elsif tg_table_name = 'sms_package_requests' then
    v_type := 'sms_balance_request'; v_title := 'طلب رصيد رسائل جديد'; v_path := '/admin'; v_dedupe := 'sms-request:' || new.id::text;
  else return new;
  end if;
  for v_admin in select u.id from public.users u
    where u.role='admin' and u.account_status='active'
      and u.platform_role in ('platform_owner','platform_admin')
  loop
    perform public.powerhub_notification_insert(
      v_admin.id,new.tenant_id,v_type,v_title,'يوجد طلب جديد بحاجة إلى المراجعة.',
      v_path,tg_table_name,new.id::text,v_dedupe,
      jsonb_build_object('request_id',new.id)
    );
  end loop;
  return new;
end;
$$;
drop trigger if exists powerhub_notify_admin_upgrade_request_after_insert on public.subscription_upgrade_requests;
create trigger powerhub_notify_admin_upgrade_request_after_insert after insert on public.subscription_upgrade_requests
for each row execute function public.powerhub_notify_admin_pending_request();
drop trigger if exists powerhub_notify_admin_sms_request_after_insert on public.sms_package_requests;
create trigger powerhub_notify_admin_sms_request_after_insert after insert on public.sms_package_requests
for each row execute function public.powerhub_notify_admin_pending_request();
