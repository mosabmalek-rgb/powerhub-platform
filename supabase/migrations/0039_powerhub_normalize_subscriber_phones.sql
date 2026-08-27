create or replace function public.powerhub_normalize_subscriber_phones(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_subscriber_ids bigint[]
)
returns table (updated_count integer, skipped_count integer)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_row record; v_compact text; v_normalized text; v_updated integer:=0; v_role text;
begin
  if coalesce(array_length(p_subscriber_ids,1),0)=0 or coalesce(array_length(p_subscriber_ids,1),0)>500 then raise exception 'INVALID_SUBSCRIBER_SELECTION' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,p_site_id);
  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select platform_role into v_role from public.users where id=p_user_id;
  for v_row in select id,phone from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and id=any(p_subscriber_ids) for update loop
    v_compact:=regexp_replace(btrim(v_row.phone),'[\s().-]','','g');
    v_normalized:=case when v_compact like '00%' then '+'||substr(v_compact,3) else v_compact end;
    if v_normalized ~ '^\+[1-9][0-9]{7,14}$' and v_normalized<>v_row.phone then
      update public.subscribers set phone=v_normalized,updated_at=now() where id=v_row.id;
      insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data)
        values(p_tenant_id,p_site_id,p_user_id,v_role,'subscriber',v_row.id::text,'normalize_phone',jsonb_build_object('phone',v_row.phone),jsonb_build_object('phone',v_normalized));
      v_updated:=v_updated+1;
    end if;
  end loop;
  return query select v_updated,cardinality(p_subscriber_ids)-v_updated;
end;
$$;
revoke execute on function public.powerhub_normalize_subscriber_phones(bigint,bigint,bigint,bigint[]) from public, anon, authenticated;
grant execute on function public.powerhub_normalize_subscriber_phones(bigint,bigint,bigint,bigint[]) to service_role;
