create or replace function public.powerhub_exceptional_locked_edit(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_entity_type text,
  p_entity_id bigint,
  p_reason text,
  p_description text default null,
  p_reference_no text default null,
  p_due_date timestamptz default null,
  p_category text default null
)
returns table (before_data jsonb, after_data jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_before jsonb; v_after jsonb; v_occurred_at timestamptz; v_settlement_id bigint; v_role text;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 10 then raise exception 'EXCEPTIONAL_EDIT_REASON_REQUIRED' using errcode = 'P0001'; end if;
  if p_entity_type not in ('invoice','payment','expense') then raise exception 'INVALID_EXCEPTIONAL_ENTITY' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(p_entity_id);

  if p_entity_type = 'invoice' then
    select to_jsonb(i), i.due_date into v_before, v_occurred_at from public.invoices i where i.id=p_entity_id and i.tenant_id=p_tenant_id and i.site_id=p_site_id for update;
    if not found then raise exception 'EXCEPTIONAL_ENTITY_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
    if p_due_date is null then raise exception 'INVALID_EXCEPTIONAL_FIELDS' using errcode = 'P0001'; end if;
  elsif p_entity_type = 'payment' then
    select to_jsonb(p), p.paid_at into v_before, v_occurred_at from public.payments p where p.id=p_entity_id and p.tenant_id=p_tenant_id and p.site_id=p_site_id for update;
    if not found then raise exception 'EXCEPTIONAL_ENTITY_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
    if p_reference_no is null then raise exception 'INVALID_EXCEPTIONAL_FIELDS' using errcode = 'P0001'; end if;
  else
    select to_jsonb(e), e.occurred_at into v_before, v_occurred_at from public.expenses e where e.id=p_entity_id and e.tenant_id=p_tenant_id and e.site_id=p_site_id for update;
    if not found then raise exception 'EXCEPTIONAL_ENTITY_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
    if p_description is null and p_reference_no is null and p_category is null then raise exception 'INVALID_EXCEPTIONAL_FIELDS' using errcode = 'P0001'; end if;
  end if;

  select id into v_settlement_id from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start <= v_occurred_at and period_end >= v_occurred_at limit 1;
  if v_settlement_id is null then raise exception 'EXCEPTIONAL_EDIT_NOT_LOCKED' using errcode = 'P0001'; end if;

  if p_entity_type = 'invoice' then
    update public.invoices set due_date=p_due_date, updated_at=now() where id=p_entity_id returning to_jsonb(invoices.*) into v_after;
  elsif p_entity_type = 'payment' then
    update public.payments set reference_no=p_reference_no, updated_at=now() where id=p_entity_id returning to_jsonb(payments.*) into v_after;
  else
    update public.expenses set description=coalesce(p_description,description), reference_no=coalesce(p_reference_no,reference_no), category=coalesce(p_category,category), updated_at=now() where id=p_entity_id returning to_jsonb(expenses.*) into v_after;
  end if;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs (tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata)
  values (p_tenant_id,p_site_id,p_user_id,v_role,p_entity_type,p_entity_id::text,'exceptional_edit_locked',v_before,v_after,jsonb_build_object('reason',p_reason,'reasonCode',case when p_reason like 'تراجع سريع%' then 'Reversal' else 'Correction' end,'settlementId',v_settlement_id));
  return query select v_before, v_after;
end;
$$;
revoke execute on function public.powerhub_exceptional_locked_edit(bigint,bigint,bigint,text,bigint,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.powerhub_exceptional_locked_edit(bigint,bigint,bigint,text,bigint,text,text,text,timestamptz,text) to service_role;
