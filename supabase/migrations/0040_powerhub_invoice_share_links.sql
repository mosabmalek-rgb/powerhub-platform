create or replace function public.powerhub_create_invoice_share_link(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_invoice_id bigint, p_token_hash text, p_token_preview text, p_expires_at timestamptz
)
returns table (share_link_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_role text;
begin
  if length(p_token_hash)<32 or length(p_token_preview)<1 then raise exception 'INVALID_SHARE_TOKEN' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,p_invoice_id);
  perform 1 from public.invoices where id=p_invoice_id and tenant_id=p_tenant_id and site_id=p_site_id and status not in ('draft','cancelled') for share;
  if not found then raise exception 'INVOICE_NOT_SHAREABLE' using errcode='P0001'; end if;
  insert into public.invoice_share_links(tenant_id,invoice_id,token_hash,token_preview,expires_at) values(p_tenant_id,p_invoice_id,p_token_hash,p_token_preview,p_expires_at) returning id into share_link_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'invoice_share_link',share_link_id::text,'create',jsonb_build_object('invoiceId',p_invoice_id));
  return next;
end;
$$;

create or replace function public.powerhub_get_shared_invoice_by_token_hash(p_token_hash text)
returns jsonb
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_link public.invoice_share_links%rowtype; v_invoice public.invoices%rowtype; v_subscriber record; v_lines jsonb;
begin
  if length(p_token_hash)<32 then raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtext(p_token_hash));
  select * into v_link from public.invoice_share_links where token_hash=p_token_hash for update;
  if not found or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001'; end if;
  select * into v_invoice from public.invoices where id=v_link.invoice_id;
  if not found then raise exception 'SHARE_LINK_NOT_FOUND' using errcode='P0001'; end if;
  select full_name,subscriber_no into v_subscriber from public.subscribers where id=v_invoice.subscriber_id and tenant_id=v_link.tenant_id;
  select coalesce(jsonb_agg(to_jsonb(line) order by line.display_order),'[]'::jsonb) into v_lines from public.invoice_lines line where line.invoice_id=v_invoice.id and line.tenant_id=v_link.tenant_id;
  update public.invoice_share_links set view_count=view_count+1,last_viewed_at=now() where id=v_link.id;
  return jsonb_build_object('invoice',to_jsonb(v_invoice),'subscriber',case when v_subscriber is null then null else jsonb_build_object('fullName',v_subscriber.full_name,'subscriberNo',v_subscriber.subscriber_no) end,'lines',v_lines);
end;
$$;

revoke execute on function public.powerhub_create_invoice_share_link(bigint,bigint,bigint,bigint,text,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.powerhub_get_shared_invoice_by_token_hash(text) from public, anon, authenticated;
grant execute on function public.powerhub_create_invoice_share_link(bigint,bigint,bigint,bigint,text,text,timestamptz) to service_role;
grant execute on function public.powerhub_get_shared_invoice_by_token_hash(text) to service_role;
