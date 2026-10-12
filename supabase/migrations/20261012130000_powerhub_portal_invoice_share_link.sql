create or replace function public.powerhub_create_portal_invoice_share_link(
  p_portal_code text,
  p_subscriber_no text,
  p_phone text,
  p_invoice_no text,
  p_token_hash text,
  p_token_preview text
)
returns table(share_link_id bigint, site_id bigint, tenant_id bigint)
language plpgsql
security definer
set search_path=''
as $$
declare
  v_portal_invoice jsonb;
  v_site_id bigint;
  v_tenant_id bigint;
  v_subscriber_id bigint;
  v_invoice_id bigint;
  v_link_id bigint;
begin
  if length(coalesce(p_token_hash,'')) < 32 or length(coalesce(p_token_preview,'')) < 1 then
    raise exception 'INVALID_SHARE_TOKEN' using errcode='P0001';
  end if;

  -- Reuse the existing public inquiry validation contract: portal enabled,
  -- subscriber number + phone match, and invoice is issued (not draft/cancelled).
  v_portal_invoice := public.powerhub_subscriber_portal_invoice(
    p_portal_code, p_subscriber_no, p_phone, p_invoice_no
  );
  if v_portal_invoice is null
     or v_portal_invoice->'subscriber' is null
     or v_portal_invoice->'invoice' is null then
    raise exception 'PORTAL_INVOICE_NOT_FOUND' using errcode='P0001';
  end if;

  select s.id, s.tenant_id
    into v_site_id, v_tenant_id
  from public.site_portal_settings p
  join public.sites s on s.id=p.site_id
  where p.portal_code=lower(btrim(p_portal_code))
    and p.is_enabled=true and s.status='active'
  limit 1;
  if v_site_id is null or v_tenant_id is null then
    raise exception 'PORTAL_NOT_AVAILABLE' using errcode='P0001';
  end if;

  select sub.id into v_subscriber_id
  from public.subscribers sub
  where sub.site_id=v_site_id
    and sub.archived_at is null
    and sub.subscriber_no=btrim(p_subscriber_no)
    and regexp_replace(coalesce(sub.phone,''),'[^0-9]','','g') =
        regexp_replace(coalesce(p_phone,''),'[^0-9]','','g')
  limit 1;
  if v_subscriber_id is null then
    -- The verification RPC above normalizes Palestinian phone variants.
    -- If raw formatting differs, resolve by the verified invoice payload but
    -- do not weaken the subscriber/site/invoice relationship checks below.
    select sub.id into v_subscriber_id
    from public.subscribers sub
    where sub.site_id=v_site_id and sub.archived_at is null
      and sub.subscriber_no=btrim(p_subscriber_no)
      and sub.id in (
        select i.subscriber_id from public.invoices i
        where i.site_id=v_site_id and i.invoice_no=btrim(p_invoice_no)
          and i.status not in ('draft','cancelled')
      )
    limit 1;
  end if;
  if v_subscriber_id is null then
    raise exception 'PORTAL_INVOICE_NOT_FOUND' using errcode='P0001';
  end if;

  select i.id into v_invoice_id
  from public.invoices i
  where i.site_id=v_site_id and i.tenant_id=v_tenant_id
    and i.subscriber_id=v_subscriber_id and i.invoice_no=btrim(p_invoice_no)
    and i.status not in ('draft','cancelled')
  limit 1;
  if v_invoice_id is null then
    raise exception 'PORTAL_INVOICE_NOT_FOUND' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('portal-invoice-share:'||v_tenant_id::text||':'||v_invoice_id::text)::bigint);
  insert into public.invoice_share_links(tenant_id,invoice_id,token_hash,token_preview,expires_at)
  values(v_tenant_id,v_invoice_id,p_token_hash,p_token_preview,now()+interval '7 days')
  returning id into v_link_id;

  share_link_id:=v_link_id;
  site_id:=v_site_id;
  tenant_id:=v_tenant_id;
  return next;
end;
$$;

revoke all on function public.powerhub_create_portal_invoice_share_link(text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.powerhub_create_portal_invoice_share_link(text,text,text,text,text,text) to service_role;
