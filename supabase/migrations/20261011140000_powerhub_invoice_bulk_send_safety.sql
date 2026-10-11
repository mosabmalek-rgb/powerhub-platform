-- Harden only the selected/all-eligible invoice SMS queue RPC. Do not redefine payment or invoice-creation triggers.
-- Existing unified-first/legacy-fallback templates, secure share-link flow, and operation-key behavior remain intact.
create or replace function public.powerhub_queue_selected_invoice_sms(
  p_user_id bigint,p_tenant_id bigint,p_site_id bigint,p_invoice_ids bigint[]
)
returns table(notification_id bigint, invoice_id bigint, queued boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $function$
declare
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_sms_enabled boolean:=false;
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_existing public.notification_messages%rowtype;
  v_template public.powerhub_message_templates%rowtype;
  v_legacy_template text;
  v_rendered_text text;
  v_payload jsonb;
  v_invoice_link text;
  v_portal_link text;
  v_share_token text;
  v_portal_code text;
  v_actor_user_id bigint;
  v_base_url text;
  v_operation_key text;
begin
  if coalesce(array_length(p_invoice_ids,1),0)=0 or coalesce(array_length(p_invoice_ids,1),0)>50 then
    raise exception 'INVALID_INVOICE_SELECTION' using errcode='P0001';
  end if;

  select exists(select 1 from public.users where id=p_user_id and account_status='active' and platform_role in ('platform_owner','platform_admin')) into v_is_platform_admin;
  select v_is_platform_admin or exists(
    select 1 from public.tenant_members members
    join public.staff_profiles staff on staff.user_id=members.user_id and staff.tenant_id=members.tenant_id and staff.site_id=p_site_id
    left join public.custom_permission_roles roles on roles.id=staff.custom_role_id and roles.tenant_id=staff.tenant_id and roles.is_active
    where members.tenant_id=p_tenant_id and members.user_id=p_user_id and members.is_active and members.membership_status='active'
      and staff.is_active and (staff.suspension_ends_at is null or staff.suspension_ends_at<=now())
      and (staff.role in ('owner','manager','accountant') or coalesce(staff.permissions,roles.permissions,'[]'::jsonb) ? 'manageMessaging')
  ) into v_allowed;
  if not v_allowed then raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode='P0001'; end if;

  -- Reject mixed or forged invoice selections instead of silently processing only in-scope rows.
  if exists (
    select 1
    from (select distinct unnest(p_invoice_ids) as selected_invoice_id) selected
    where not exists (
      select 1 from public.invoices i
      where i.id=selected.selected_invoice_id and i.tenant_id=p_tenant_id and i.site_id=p_site_id
    )
  ) then
    raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean,true)
  into v_sms_enabled from public.platform_settings where setting_key='invoice_delivery_channels';
  if coalesce(v_sms_enabled,false) is not true then raise exception 'SMS_CHANNEL_DISABLED' using errcode='P0001'; end if;

  select * into v_template
  from public.powerhub_message_templates
  where tenant_id=p_tenant_id and channel='sms' and event_type='invoice_issued' and is_active
  order by updated_at desc,id desc limit 1;

  if v_template.id is null then
    select body into v_legacy_template from public.tenant_invoice_message_templates
    where tenant_id=p_tenant_id and channel='sms' and event_type='invoice_issued' and is_active
    order by updated_at desc limit 1;
  end if;

  for v_invoice in
    select * from public.invoices
    where id=any(p_invoice_ids) and tenant_id=p_tenant_id and site_id=p_site_id
    order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended(format('powerhub:invoice-sms:%s:%s', v_invoice.tenant_id, v_invoice.id), 0));

    if v_invoice.status in ('draft','cancelled') then
      raise exception 'INVOICE_NOT_SENDABLE' using errcode='P0001';
    end if;

    select n.* into v_existing
    from public.notification_messages as n
    where n.tenant_id=p_tenant_id and n.invoice_id=v_invoice.id
      and n.channel='sms' and n.event_type='invoice_issued'
    order by n.id desc limit 1 for update;

    if found and v_existing.status in ('pending','processing','submitted','delivered','read','failed','needs_review') then
      notification_id:=v_existing.id; invoice_id:=v_invoice.id; queued:=false; return next; continue;
    end if;

    select * into v_subscriber from public.subscribers
    where id=v_invoice.subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id;
    if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001'; end if;

    v_operation_key:=format('invoice:%s:invoice_issued',v_invoice.id);
    v_payload:=coalesce(v_existing.payload,'{}'::jsonb);
    v_invoice_link:=nullif(v_payload->>'invoiceLink','');
    v_portal_link:=nullif(v_payload->>'portalLink','');

    if v_invoice_link is null and (coalesce((select invoice_message_style from public.tenant_messaging_configurations where tenant_id=p_tenant_id and channel='sms'),'details')='portal_link'
      or position('{{invoice_link}}' in coalesce(v_template.body,v_legacy_template,''))>0) then
      v_base_url:=public.powerhub_public_base_url();
      select id into v_actor_user_id from public.users
      where account_status='active' and platform_role in ('platform_owner','platform_admin')
      order by id limit 1;
      if v_actor_user_id is null then raise exception 'NO_PLATFORM_AUTOMATION_ACTOR' using errcode='P0001'; end if;
      v_share_token:=translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');
      perform 1 from public.powerhub_create_invoice_share_link(
        p_tenant_id,p_site_id,v_actor_user_id,v_invoice.id,encode(digest(v_share_token,'sha256'),'hex'),left(v_share_token,8),null
      );
      v_invoice_link:=v_base_url || '/invoice/' || v_share_token;
    end if;

    if v_portal_link is null then
      select portal_code into v_portal_code from public.site_portal_settings where tenant_id=p_tenant_id and site_id=p_site_id limit 1;
      if v_portal_code is not null then
        v_base_url:=coalesce(v_base_url,public.powerhub_public_base_url());
        v_portal_link:=v_base_url || '/portal?g=' || v_portal_code;
      end if;
    end if;

    v_rendered_text:=coalesce(v_template.body,v_legacy_template,
      'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.');
    if coalesce((select invoice_message_style from public.tenant_messaging_configurations where tenant_id=p_tenant_id and channel='sms'),'details')='portal_link'
      and position('{{invoice_link}}' in v_rendered_text)=0 then
      v_rendered_text:=rtrim(v_rendered_text)||' رابط الفاتورة: {{invoice_link}}';
    end if;
    v_rendered_text:=replace(v_rendered_text,'{{subscriber_name}}',coalesce(v_subscriber.full_name,''));
    v_rendered_text:=replace(v_rendered_text,'{{subscriber_no}}',coalesce(v_subscriber.subscriber_no,''));
    v_rendered_text:=replace(v_rendered_text,'{{invoice_no}}',v_invoice.invoice_no);
    v_rendered_text:=replace(v_rendered_text,'{{billing_period}}',v_invoice.billing_period);
    v_rendered_text:=replace(v_rendered_text,'{{total_amount}}',v_invoice.total_amount::text);
    v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',v_invoice.balance_due::text);
    v_rendered_text:=replace(v_rendered_text,'{{due_date}}',to_char(v_invoice.due_date at time zone 'Asia/Gaza','YYYY-MM-DD'));
    v_rendered_text:=replace(v_rendered_text,'{{invoice_link}}',coalesce(v_invoice_link,''));
    v_rendered_text:=replace(v_rendered_text,'{{portal_link}}',coalesce(v_portal_link,''));

    if found and v_existing.status='failed' then
      update public.notification_messages
      set status='pending',recipient=v_subscriber.phone,payload=jsonb_set(
        coalesce(v_existing.payload,'{}'::jsonb),'{renderedText}',to_jsonb(v_rendered_text)
      ) || jsonb_build_object('invoiceLink',v_invoice_link,'portalLink',v_portal_link,'operationKey',v_operation_key),
      last_error=null,updated_at=now(),operation_key=v_operation_key
      where id=v_existing.id;
      notification_id:=v_existing.id;
    else
      insert into public.notification_messages(
        tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,send_type,schedule_type,template_id,payload,operation_key
      ) values (
        p_tenant_id,v_invoice.id,v_subscriber.id,'sms','invoice_issued',v_subscriber.phone,'pending','manual','none',v_template.id,
        jsonb_build_object('invoiceNo',v_invoice.invoice_no,'billingPeriod',v_invoice.billing_period,'totalAmount',v_invoice.total_amount,
          'renderedText',v_rendered_text,'invoiceLink',v_invoice_link,'portalLink',v_portal_link,'queuedBy','manual_invoice_selection','operationKey',v_operation_key),
        v_operation_key
      )
      on conflict (tenant_id,operation_key) do update
        set status=case when public.notification_messages.status='failed' then 'pending' else public.notification_messages.status end,
            last_error=case when public.notification_messages.status='failed' then null else public.notification_messages.last_error end,
            updated_at=now()
      returning id into notification_id;
    end if;

    invoice_id:=v_invoice.id; queued:=true; return next;
  end loop;
end;
$function$;

revoke execute on function public.powerhub_queue_selected_invoice_sms(bigint,bigint,bigint,bigint[]) from public, anon, authenticated;
grant execute on function public.powerhub_queue_selected_invoice_sms(bigint,bigint,bigint,bigint[]) to service_role;
