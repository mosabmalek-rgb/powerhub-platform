-- Align field-sync notifications with the actual mobile_sync_events contract.
-- The table permits sync_cycle/sync_error (not the legacy reading_sync variants).
create or replace function public.powerhub_notify_field_sync_received()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner_user_id bigint;
begin
  if tg_op <> 'INSERT' or new.event_type <> 'sync_cycle' then return new; end if;
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
