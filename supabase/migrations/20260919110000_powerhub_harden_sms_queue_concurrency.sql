create or replace function public.powerhub_queue_selected_invoice_sms(
  p_user_id bigint,
  p_tenant_id bigint,
  p_site_id bigint,
  p_invoice_ids bigint[]
)
returns table(notification_id bigint, invoice_id bigint, queued boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $function$
declare
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_sms_enabled boolean := false;
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_existing public.notification_messages%rowtype;
  v_template text;
  v_rendered_text text;
  v_candidate_id bigint;
begin
  if coalesce(array_length(p_invoice_ids,1),0)=0 or coalesce(array_length(p_invoice_ids,1),0)>200
    then raise exception 'INVALID_INVOICE_SELECTION' using errcode='P0001';
  end if;
  select exists(
    select 1 from public.users where id=p_user_id and account_status='active'
      and platform_role in ('platform_owner','platform_admin')
  ) into v_is_platform_admin;
  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members members
    inner join public.staff_profiles staff
      on staff.user_id=members.user_id
      and staff.tenant_id=members.tenant_id
      and staff.site_id=p_site_id
    left join public.custom_permission_roles roles
      on roles.id=staff.custom_role_id
      and roles.tenant_id=staff.tenant_id
      and roles.is_active=true
    where members.tenant_id=p_tenant_id
      and members.user_id=p_user_id
      and members.is_active
      and members.membership_status='active'
      and staff.is_active
      and (staff.suspension_ends_at is null or staff.suspension_ends_at<=now())
      and (
        staff.role in ('owner','manager','accountant')
        or coalesce(staff.permissions,roles.permissions,'[]'::jsonb) ? 'manageMessaging'
      )
  ) into v_allowed;
  if not v_allowed then raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode='P0001'; end if;
  select is_enabled and coalesce((value->>'smsEnabled')::boolean,true)
    into v_sms_enabled
    from public.platform_settings
    where setting_key='invoice_delivery_channels';
  if coalesce(v_sms_enabled,false) is not true
    then raise exception 'SMS_CHANNEL_DISABLED' using errcode='P0001';
  end if;
  select body into v_template
    from public.tenant_invoice_message_templates
    where tenant_id=p_tenant_id
      and channel='sms'
      and event_type='invoice_issued'
      and is_active
    order by updated_at desc
    limit 1;

  for v_candidate_id in select distinct unnest(p_invoice_ids) loop
    perform pg_advisory_xact_lock(hashtext('invoice-sms:'||p_tenant_id::text||':'||v_candidate_id::text));

    select * into v_invoice
      from public.invoices
      where id=v_candidate_id
        and tenant_id=p_tenant_id
        and site_id=p_site_id
      for update;
    if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;
    if v_invoice.status in ('draft','cancelled')
      then raise exception 'INVOICE_NOT_SENDABLE' using errcode='P0001';
    end if;
    select * into v_subscriber
      from public.subscribers
      where id=v_invoice.subscriber_id
        and tenant_id=p_tenant_id
        and site_id=p_site_id;
    if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001'; end if;

    select * into v_existing
      from public.notification_messages
      where tenant_id=p_tenant_id
        and invoice_id=v_invoice.id
        and channel='sms'
        and event_type='invoice_issued'
      order by created_at desc,id desc
      limit 1
      for update;

    if found and v_existing.status in ('processing','submitted','delivered','read') then
      notification_id:=v_existing.id;
      invoice_id:=v_invoice.id;
      queued:=false;
      return next;
      continue;
    end if;

    if found and v_existing.status='needs_review'
      then raise exception 'NOTIFICATION_NEEDS_REVIEW' using errcode='P0001';
    end if;

    v_rendered_text:=coalesce(
      v_template,
      'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.'
    );
    v_rendered_text:=replace(v_rendered_text,'{{subscriber_name}}',v_subscriber.full_name);
    v_rendered_text:=replace(v_rendered_text,'{{invoice_no}}',v_invoice.invoice_no);
    v_rendered_text:=replace(v_rendered_text,'{{billing_period}}',v_invoice.billing_period);
    v_rendered_text:=replace(v_rendered_text,'{{total_amount}}',v_invoice.total_amount::text);
    v_rendered_text:=replace(v_rendered_text,'{{due_date}}',to_char(v_invoice.due_date at time zone 'Asia/Gaza','YYYY-MM-DD'));

    if found then
      update public.notification_messages
      set status='pending',
          recipient=v_subscriber.phone,
          payload=jsonb_build_object(
            'invoiceNo',v_invoice.invoice_no,
            'billingPeriod',v_invoice.billing_period,
            'totalAmount',v_invoice.total_amount,
            'renderedText',v_rendered_text,
            'queuedBy','manual_invoice_selection'
          ),
          last_error=null,
          updated_at=now()
      where id=v_existing.id;
      notification_id:=v_existing.id;
    else
      insert into public.notification_messages(
        tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,payload
      )
      values(
        p_tenant_id,v_invoice.id,v_subscriber.id,'sms','invoice_issued',v_subscriber.phone,'pending',
        jsonb_build_object(
          'invoiceNo',v_invoice.invoice_no,
          'billingPeriod',v_invoice.billing_period,
          'totalAmount',v_invoice.total_amount,
          'renderedText',v_rendered_text,
          'queuedBy','manual_invoice_selection'
        )
      )
      returning id into notification_id;
    end if;

    invoice_id:=v_invoice.id;
    queued:=true;
    return next;
  end loop;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata
  )
  values(
    p_tenant_id,p_site_id,p_user_id,
    (select platform_role from public.users where id=p_user_id),
    'notification_batch',array_to_string(p_invoice_ids,','),
    'queue_selected_invoice_sms',
    jsonb_build_object('invoiceCount',coalesce(array_length(p_invoice_ids,1),0))
  );
end;
$function$;

revoke execute on function public.powerhub_queue_selected_invoice_sms(bigint,bigint,bigint,bigint[]) from public,anon,authenticated;
grant execute on function public.powerhub_queue_selected_invoice_sms(bigint,bigint,bigint,bigint[]) to service_role;

create or replace function public.powerhub_queue_payment_sms(
  p_user_id bigint,
  p_tenant_id bigint,
  p_site_id bigint,
  p_event_type text,
  p_invoice_id bigint,
  p_payment_id bigint,
  p_operation_key text,
  p_rendered_text text
)
returns table(notification_id bigint,queued boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $function$
declare
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_sms_enabled boolean:=false;
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_payment public.payments%rowtype;
  v_existing public.notification_messages%rowtype;
begin
  if p_event_type not in ('payment_reminder','payment_received')
    then raise exception 'INVALID_PAYMENT_SMS_EVENT' using errcode='P0001';
  end if;
  if nullif(trim(p_operation_key),'') is null or nullif(trim(p_rendered_text),'') is null
    then raise exception 'PAYMENT_SMS_PAYLOAD_REQUIRED' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('payment-sms:'||p_tenant_id::text||':'||p_site_id::text||':'||p_event_type||':'||trim(p_operation_key))
  );

  select exists(
    select 1 from public.users where id=p_user_id and account_status='active'
      and platform_role in ('platform_owner','platform_admin')
  ) into v_is_platform_admin;
  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members members
    inner join public.staff_profiles staff
      on staff.user_id=members.user_id
      and staff.tenant_id=members.tenant_id
      and staff.site_id=p_site_id
    left join public.custom_permission_roles roles
      on roles.id=staff.custom_role_id
      and roles.tenant_id=staff.tenant_id
      and roles.is_active=true
    where members.tenant_id=p_tenant_id
      and members.user_id=p_user_id
      and members.is_active
      and members.membership_status='active'
      and staff.is_active
      and (staff.suspension_ends_at is null or staff.suspension_ends_at<=now())
      and (
        staff.role in ('owner','manager','accountant')
        or coalesce(staff.permissions,roles.permissions,'[]'::jsonb) ? 'manageMessaging'
      )
  ) into v_allowed;
  if not v_allowed then raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode='P0001'; end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean,true)
    into v_sms_enabled
    from public.platform_settings
    where setting_key='invoice_delivery_channels';
  if coalesce(v_sms_enabled,false) is not true
    then raise exception 'SMS_CHANNEL_DISABLED' using errcode='P0001';
  end if;

  select * into v_invoice
    from public.invoices
    where id=p_invoice_id
      and tenant_id=p_tenant_id
      and site_id=p_site_id
    for update;
  if not found then raise exception 'INVOICE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select * into v_subscriber
    from public.subscribers
    where id=v_invoice.subscriber_id
      and tenant_id=p_tenant_id
      and site_id=p_site_id;
  if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if p_event_type='payment_reminder'
     and (v_invoice.status in ('draft','cancelled','paid') or v_invoice.balance_due<=0)
    then raise exception 'REMINDER_NOT_SENDABLE' using errcode='P0001';
  end if;

  if p_event_type='payment_received' then
    if p_payment_id is null then raise exception 'PAYMENT_REQUIRED' using errcode='P0001'; end if;
    select * into v_payment
      from public.payments
      where id=p_payment_id
        and tenant_id=p_tenant_id
        and site_id=p_site_id
        and invoice_id=p_invoice_id
        and status='completed';
    if not found then raise exception 'PAYMENT_OUT_OF_SCOPE' using errcode='P0001'; end if;
  end if;

  select * into v_existing
    from public.notification_messages
    where tenant_id=p_tenant_id
      and channel='sms'
      and event_type=p_event_type
      and payload->>'operationKey'=trim(p_operation_key)
    order by created_at desc,id desc
    limit 1
    for update;

  if found and v_existing.status in ('processing','submitted','delivered','read') then
    notification_id:=v_existing.id;
    queued:=false;
    return next;
    return;
  end if;

  if found and v_existing.status='needs_review'
    then raise exception 'NOTIFICATION_NEEDS_REVIEW' using errcode='P0001';
  end if;

  if found then
    update public.notification_messages
    set status='pending',
        invoice_id=v_invoice.id,
        subscriber_id=v_subscriber.id,
        recipient=v_subscriber.phone,
        payload=jsonb_build_object(
          'renderedText',p_rendered_text,
          'operationKey',trim(p_operation_key),
          'paymentId',p_payment_id
        ),
        last_error=null,
        updated_at=now()
    where id=v_existing.id;
    notification_id:=v_existing.id;
  else
    insert into public.notification_messages(
      tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,payload
    )
    values(
      p_tenant_id,v_invoice.id,v_subscriber.id,'sms',p_event_type,v_subscriber.phone,'pending',
      jsonb_build_object(
        'renderedText',p_rendered_text,
        'operationKey',trim(p_operation_key),
        'paymentId',p_payment_id
      )
    )
    returning id into notification_id;
  end if;

  queued:=true;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata
  )
  values(
    p_tenant_id,p_site_id,p_user_id,
    (select platform_role from public.users where id=p_user_id),
    'notification_message',notification_id::text,
    'queue_payment_sms',
    jsonb_build_object(
      'eventType',p_event_type,
      'invoiceId',p_invoice_id,
      'paymentId',p_payment_id,
      'operationKey',trim(p_operation_key)
    )
  );
  return next;
end;
$function$;

revoke execute on function public.powerhub_queue_payment_sms(bigint,bigint,bigint,text,bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_queue_payment_sms(bigint,bigint,bigint,text,bigint,bigint,text,text) to service_role;
