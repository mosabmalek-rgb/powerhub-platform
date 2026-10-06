-- Reconcile the production addon-request RPC ambiguity and keep the quota authority migration-safe.
create or replace function public.powerhub_request_tenant_addon(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_addon_code text,p_quantity integer default 1,p_note text default null
)
returns table(request_id bigint,addon_code text,quantity integer,already_requested boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_existing_id bigint; v_existing_qty integer;
begin
 if p_addon_code not in ('fieldUser','platformUser','subscribers50','branch','sms') then raise exception 'INVALID_ADDON_CODE' using errcode='P0001'; end if;
 if p_quantity is null or p_quantity<1 or p_quantity>1000 then raise exception 'INVALID_ADDON_QUANTITY' using errcode='P0001'; end if;
 if not exists(select 1 from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and role='owner' and is_active=true and membership_status='active') then
   raise exception 'ADDON_REQUEST_OWNER_ONLY' using errcode='42501';
 end if;
 if p_site_id is not null and not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived') then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select r.id,r.quantity into v_existing_id,v_existing_qty
 from public.tenant_addon_requests as r
 where r.tenant_id=p_tenant_id and r.addon_code=p_addon_code and r.status in ('pending','reviewing')
 order by r.created_at desc limit 1 for update;
 if found then return query select v_existing_id,p_addon_code,v_existing_qty,true; return; end if;
 insert into public.tenant_addon_requests(tenant_id,site_id,requested_by_user_id,addon_code,quantity,note)
 values(p_tenant_id,p_site_id,p_user_id,p_addon_code,p_quantity,p_note)
 returning id into v_existing_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'tenant_addon_request',v_existing_id::text,'request_addon',jsonb_build_object('addonCode',p_addon_code,'quantity',p_quantity,'note',p_note));
 return query select v_existing_id,p_addon_code,p_quantity,false;
end;
$$;
revoke all on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text) to service_role;
