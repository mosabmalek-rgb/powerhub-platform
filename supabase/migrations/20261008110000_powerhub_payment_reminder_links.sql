create or replace function public.powerhub_payment_public_base_url()
returns text
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_url text;
begin
  select nullif(trim(value->>'baseUrl'),'') into v_url
  from public.platform_settings
  where setting_key='powerhub_public_url' and is_enabled=true
  limit 1;
  if v_url is null then v_url := 'https://powerhub-platform.vercel.app'; end if;
  return regexp_replace(v_url,'/+$','');
end;
$function$;

revoke execute on function public.powerhub_payment_public_base_url() from public,anon,authenticated;
grant execute on function public.powerhub_payment_public_base_url() to service_role;

-- PowerHub: payment reminder queue hardening.
-- Keeps the reminder template independent from invoice issuance and makes
-- invoice/portal links atomic, idempotent, tenant-scoped, and retry-safe.

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
returns table(notification_id bigint, queued boolean)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_sms_enabled boolean := false;
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_payment public.payments%rowtype;
  v_existing public.notification_messages%rowtype;
  v_invoice_link text;
  v_portal_link text;
  v_share_token text;
  v_portal_code text;
  v_base_url text;
  v_rendered_text text := p_rendered_text;
begin
  if p_event_type not in ('payment_reminder', 'payment_received') then
    raise exception 'INVALID_PAYMENT_SMS_EVENT' using errcode = 'P0001';
  end if;
  if nullif(trim(p_operation_key), '') is null or nullif(trim(p_rendered_text), '') is null then
    raise exception 'PAYMENT_SMS_PAYLOAD_REQUIRED' using errcode = 'P0001';
  end if;

  -- Serialize identical retry/concurrent-click operations per tenant.
  perform pg_advisory_xact_lock(p_tenant_id, hashtext(trim(p_operation_key)));

  select exists(
    select 1
    from public.users
    where id = p_user_id
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  ) into v_is_platform_admin;

  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members as members
    inner join public.staff_profiles as staff
      on staff.user_id = members.user_id
      and staff.tenant_id = members.tenant_id
      and staff.site_id = p_site_id
    left join public.custom_permission_roles as roles
      on roles.id = staff.custom_role_id
      and roles.tenant_id = staff.tenant_id
      and roles.is_active = true
    where members.tenant_id = p_tenant_id
      and members.user_id = p_user_id
      and members.is_active
      and members.membership_status = 'active'
      and staff.is_active
      and (staff.suspension_ends_at is null or staff.suspension_ends_at <= now())
      and (
        staff.role in ('owner', 'manager', 'accountant')
        or coalesce(staff.permissions, roles.permissions, '[]'::jsonb) ? 'manageMessaging'
      )
  ) into v_allowed;

  if not v_allowed then
    raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode = 'P0001';
  end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean, true)
  into v_sms_enabled
  from public.platform_settings
  where setting_key = 'invoice_delivery_channels';

  if coalesce(v_sms_enabled, false) is not true then
    raise exception 'SMS_CHANNEL_DISABLED' using errcode = 'P0001';
  end if;

  select *
  into v_invoice
  from public.invoices
  where id = p_invoice_id
    and tenant_id = p_tenant_id
    and site_id = p_site_id
  for update;

  if not found then
    raise exception 'INVOICE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select *
  into v_subscriber
  from public.subscribers
  where id = v_invoice.subscriber_id
    and tenant_id = p_tenant_id
    and site_id = p_site_id;

  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_event_type = 'payment_reminder'
     and (v_invoice.status in ('draft', 'cancelled', 'paid') or v_invoice.balance_due <= 0) then
    raise exception 'REMINDER_NOT_SENDABLE' using errcode = 'P0001';
  end if;

  if p_event_type = 'payment_received' then
    if p_payment_id is null then
      raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001';
    end if;

    select *
    into v_payment
    from public.payments
    where id = p_payment_id
      and tenant_id = p_tenant_id
      and site_id = p_site_id
      and invoice_id = p_invoice_id
      and status = 'completed';

    if not found then
      raise exception 'PAYMENT_OUT_OF_SCOPE' using errcode = 'P0001';
    end if;
  end if;

  v_base_url := public.powerhub_payment_public_base_url();

  select *
  into v_existing
  from public.notification_messages
  where tenant_id = p_tenant_id
    and channel = 'sms'
    and event_type = p_event_type
    and operation_key = trim(p_operation_key)
  order by created_at desc, id desc
  limit 1
  for update;

  if found and v_existing.status in ('processing', 'submitted', 'delivered', 'read') then
    notification_id := v_existing.id;
    queued := false;
    return next;
    return;
  end if;

  if p_event_type = 'payment_reminder' then
    v_invoice_link := nullif(v_existing.payload->>'invoiceLink', '');
    v_portal_link := nullif(v_existing.payload->>'portalLink', '');

    if position('{{invoice_link}}' in v_rendered_text) > 0 and v_invoice_link is null then
      v_share_token := encode(gen_random_bytes(24), 'base64url');
      perform public.powerhub_create_invoice_share_link(
        p_tenant_id,
        p_site_id,
        p_user_id,
        p_invoice_id,
        encode(digest(v_share_token, 'sha256'), 'hex'),
        left(v_share_token, 8),
        null
      );
      v_invoice_link := v_base_url || '/invoice/' || v_share_token;
    end if;

    if position('{{portal_link}}' in v_rendered_text) > 0 and v_portal_link is null then
      select portal_code
      into v_portal_code
      from public.site_portal_settings
      where tenant_id = p_tenant_id
        and site_id = p_site_id
      limit 1;

      if v_portal_code is not null then
        v_portal_link := v_base_url || '/portal?g=' || v_portal_code;
      else
        v_portal_link := '';
      end if;
    end if;

    v_rendered_text := replace(v_rendered_text, '{{invoice_link}}', coalesce(v_invoice_link, ''));
    v_rendered_text := replace(v_rendered_text, '{{portal_link}}', coalesce(v_portal_link, ''));
  end if;

  if v_existing.id is not null then
    update public.notification_messages
    set status = 'pending',
        invoice_id = v_invoice.id,
        subscriber_id = v_subscriber.id,
        recipient = v_subscriber.phone,
        payload = jsonb_build_object(
          'renderedText', v_rendered_text,
          'operationKey', trim(p_operation_key),
          'paymentId', p_payment_id,
          'invoiceLink', v_invoice_link,
          'portalLink', v_portal_link
        ),
        last_error = null,
        updated_at = now()
    where id = v_existing.id;

    notification_id := v_existing.id;
  else
    insert into public.notification_messages(
      tenant_id,
      invoice_id,
      subscriber_id,
      channel,
      event_type,
      recipient,
      status,
      payload
    )
    values (
      p_tenant_id,
      v_invoice.id,
      v_subscriber.id,
      'sms',
      p_event_type,
      v_subscriber.phone,
      'pending',
      jsonb_build_object(
        'renderedText', v_rendered_text,
        'operationKey', trim(p_operation_key),
        'paymentId', p_payment_id,
        'invoiceLink', v_invoice_link,
        'portalLink', v_portal_link
      )
    )
    returning id into notification_id;
  end if;

  queued := true;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    metadata
  )
  values (
    p_tenant_id,
    p_site_id,
    p_user_id,
    (select platform_role from public.users where id = p_user_id),
    'notification_message',
    notification_id::text,
    'queue_payment_sms',
    jsonb_build_object(
      'eventType', p_event_type,
      'invoiceId', p_invoice_id,
      'paymentId', p_payment_id,
      'operationKey', trim(p_operation_key),
      'invoiceLinkAttached', v_invoice_link is not null,
      'portalLinkAttached', v_portal_link is not null
    )
  );

  return next;
end;
$$;

revoke execute on function public.powerhub_queue_payment_sms(bigint, bigint, bigint, text, bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_queue_payment_sms(bigint, bigint, bigint, text, bigint, bigint, text, text) to service_role;
