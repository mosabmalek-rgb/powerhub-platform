-- PowerHub: per-invoice secure share links for unified invoice messaging.
-- Each notification stores the exact link that belongs to its own invoice.
-- Replays reuse the stored link instead of creating a second public link.

create or replace function public.powerhub_queue_invoice_sms_after_issue()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_subscriber public.subscribers%rowtype;
  v_template text;
  v_sms_enabled boolean := false;
  v_auto_enabled boolean := false;
  v_invoice_style text := 'details';
  v_rendered_text text;
  v_schedule_mode text := 'immediate';
  v_anchor_at timestamptz;
  v_scheduled_at timestamptz;
  v_share_token text;
  v_invoice_link text;
  v_portal_link text;
  v_portal_code text;
begin
  perform pg_advisory_xact_lock(new.id);

  select *
  into v_subscriber
  from public.subscribers
  where id = new.subscriber_id
    and tenant_id = new.tenant_id
    and site_id = new.site_id;

  if not found then
    return new;
  end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean, true)
  into v_sms_enabled
  from public.platform_settings
  where setting_key = 'invoice_delivery_channels';

  if coalesce(v_sms_enabled, false) is not true then
    return new;
  end if;

  select
    coalesce(auto_send_after_approval, false),
    coalesce(invoice_sms_schedule_mode, 'immediate'),
    invoice_sms_schedule_anchor_at,
    coalesce(invoice_message_style, 'details')
  into v_auto_enabled, v_schedule_mode, v_anchor_at, v_invoice_style
  from public.tenant_messaging_configurations
  where tenant_id = new.tenant_id
    and channel = 'sms'
  limit 1;

  if coalesce(v_auto_enabled, false) is not true then
    return new;
  end if;

  v_scheduled_at := public.powerhub_invoice_sms_next_schedule(
    new.created_at,
    v_schedule_mode,
    v_anchor_at
  );

  select body
  into v_template
  from public.tenant_invoice_message_templates
  where tenant_id = new.tenant_id
    and channel = 'sms'
    and event_type = 'invoice_issued'
    and is_active = true
  order by updated_at desc
  limit 1;

  v_rendered_text := coalesce(
    v_template,
    case
      when v_invoice_style = 'portal_link'
        then 'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} بقيمة {{total_amount}}. رابط الفاتورة: {{invoice_link}}'
      else
        'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.'
    end
  );

  if v_invoice_style = 'portal_link'
     or position('{{invoice_link}}' in v_rendered_text) > 0 then
    v_share_token := encode(gen_random_bytes(24), 'base64url');

    insert into public.invoice_share_links(
      tenant_id,
      invoice_id,
      token_hash,
      token_preview,
      expires_at
    )
    values (
      new.tenant_id,
      new.id,
      encode(digest(v_share_token, 'sha256'), 'hex'),
      left(v_share_token, 8),
      null
    );

    v_invoice_link := 'https://powerhub-platform.vercel.app/invoice/' || v_share_token;
  end if;

  select portal_code
  into v_portal_code
  from public.site_portal_settings
  where tenant_id = new.tenant_id
    and site_id = new.site_id
  limit 1;

  if v_portal_code is not null then
    v_portal_link := 'https://powerhub-platform.vercel.app/portal?g=' || v_portal_code;
  else
    v_portal_link := '';
  end if;

  v_rendered_text := replace(v_rendered_text, '{{subscriber_name}}', coalesce(v_subscriber.full_name, ''));
  v_rendered_text := replace(v_rendered_text, '{{subscriber_no}}', coalesce(v_subscriber.subscriber_no, ''));
  v_rendered_text := replace(v_rendered_text, '{{invoice_no}}', new.invoice_no);
  v_rendered_text := replace(v_rendered_text, '{{billing_period}}', new.billing_period);
  v_rendered_text := replace(v_rendered_text, '{{total_amount}}', new.total_amount::text);
  v_rendered_text := replace(v_rendered_text, '{{due_date}}', to_char(new.due_date at time zone 'Asia/Gaza', 'YYYY-MM-DD'));
  v_rendered_text := replace(v_rendered_text, '{{invoice_link}}', coalesce(v_invoice_link, ''));
  v_rendered_text := replace(v_rendered_text, '{{portal_link}}', coalesce(v_portal_link, ''));

  insert into public.notification_messages(
    tenant_id,
    invoice_id,
    subscriber_id,
    channel,
    event_type,
    recipient,
    status,
    scheduled_at,
    send_type,
    schedule_type,
    payload
  )
  values (
    new.tenant_id,
    new.id,
    new.subscriber_id,
    'sms',
    'invoice_issued',
    coalesce(v_subscriber.phone, ''),
    'pending',
    v_scheduled_at,
    'automatic',
    case when v_schedule_mode = 'immediate' then 'none' else v_schedule_mode end,
    jsonb_build_object(
      'invoiceNo', new.invoice_no,
      'billingPeriod', new.billing_period,
      'totalAmount', new.total_amount,
      'renderedText', v_rendered_text,
      'invoiceLink', v_invoice_link,
      'portalLink', v_portal_link,
      'queuedBy', 'invoice_issue',
      'scheduleMode', v_schedule_mode,
      'scheduledAt', v_scheduled_at
    )
  )
  on conflict (tenant_id, invoice_id, channel, event_type)
    where invoice_id is not null
      and channel = 'sms'
      and event_type = 'invoice_issued'
    do nothing;

  return new;
end;
$function$;

revoke execute on function public.powerhub_queue_invoice_sms_after_issue() from public, anon, authenticated;
grant execute on function public.powerhub_queue_invoice_sms_after_issue() to service_role;

create or replace function public.powerhub_queue_selected_invoice_sms(
  p_user_id bigint,
  p_tenant_id bigint,
  p_site_id bigint,
  p_invoice_ids bigint[]
)
returns table(notification_id bigint, invoice_id bigint, queued boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
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
  v_payload jsonb;
  v_invoice_link text;
  v_portal_link text;
  v_share_token text;
  v_portal_code text;
  v_candidate_id bigint;
begin
  if coalesce(array_length(p_invoice_ids, 1), 0) = 0
     or coalesce(array_length(p_invoice_ids, 1), 0) > 50 then
    raise exception 'INVALID_INVOICE_SELECTION' using errcode = 'P0001';
  end if;

  select exists(
    select 1
    from public.users
    where id = p_user_id
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  )
  into v_is_platform_admin;

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
  )
  into v_allowed;

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

  select body
  into v_template
  from public.tenant_invoice_message_templates
  where tenant_id = p_tenant_id
    and channel = 'sms'
    and event_type = 'invoice_issued'
    and is_active
  order by updated_at desc
  limit 1;

  for v_candidate_id in select distinct unnest(p_invoice_ids) loop
    select *
    into v_invoice
    from public.invoices
    where id = v_candidate_id
      and tenant_id = p_tenant_id
      and site_id = p_site_id
    for update;

    if not found then
      raise exception 'INVOICE_OUT_OF_SCOPE' using errcode = 'P0001';
    end if;

    -- Serialize all invoice-message preparation paths for this invoice. This
    -- prevents concurrent manual/automatic queueing from minting two links.
    perform pg_advisory_xact_lock(v_invoice.id);

    if v_invoice.status in ('draft', 'cancelled') then
      raise exception 'INVOICE_NOT_SENDABLE' using errcode = 'P0001';
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

    select *
    into v_existing
    from public.notification_messages
    where tenant_id = p_tenant_id
      and invoice_id = v_invoice.id
      and channel = 'sms'
      and event_type = 'invoice_issued'
    order by created_at desc, id desc
    limit 1
    for update;

    if found and v_existing.status in ('processing', 'submitted', 'delivered', 'read') then
      notification_id := v_existing.id;
      invoice_id := v_invoice.id;
      queued := false;
      return next;
      continue;
    end if;

    v_payload := coalesce(v_existing.payload, '{}'::jsonb);
    v_invoice_link := nullif(v_payload->>'invoiceLink', '');
    v_portal_link := nullif(v_payload->>'portalLink', '');

    if v_invoice_link is null then
      v_share_token := encode(gen_random_bytes(24), 'base64url');
      insert into public.invoice_share_links(
        tenant_id,
        invoice_id,
        token_hash,
        token_preview,
        expires_at
      )
      values (
        p_tenant_id,
        v_invoice.id,
        encode(digest(v_share_token, 'sha256'), 'hex'),
        left(v_share_token, 8),
        null
      );
      v_invoice_link := 'https://powerhub-platform.vercel.app/invoice/' || v_share_token;
    end if;

    if v_portal_link is null then
      select portal_code
      into v_portal_code
      from public.site_portal_settings
      where tenant_id = p_tenant_id
        and site_id = p_site_id
      limit 1;

      if v_portal_code is not null then
        v_portal_link := 'https://powerhub-platform.vercel.app/portal?g=' || v_portal_code;
      end if;
    end if;

    v_rendered_text := coalesce(
      v_template,
      'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.'
    );

    v_rendered_text := replace(v_rendered_text, '{{subscriber_name}}', coalesce(v_subscriber.full_name, ''));
    v_rendered_text := replace(v_rendered_text, '{{subscriber_no}}', coalesce(v_subscriber.subscriber_no, ''));
    v_rendered_text := replace(v_rendered_text, '{{invoice_no}}', v_invoice.invoice_no);
    v_rendered_text := replace(v_rendered_text, '{{billing_period}}', v_invoice.billing_period);
    v_rendered_text := replace(v_rendered_text, '{{total_amount}}', v_invoice.total_amount::text);
    v_rendered_text := replace(v_rendered_text, '{{due_date}}', to_char(v_invoice.due_date at time zone 'Asia/Gaza', 'YYYY-MM-DD'));
    v_rendered_text := replace(v_rendered_text, '{{invoice_link}}', coalesce(v_invoice_link, ''));
    v_rendered_text := replace(v_rendered_text, '{{portal_link}}', coalesce(v_portal_link, ''));

    if found then
      update public.notification_messages
      set status = 'pending',
          recipient = v_subscriber.phone,
          payload = jsonb_build_object(
            'invoiceNo', v_invoice.invoice_no,
            'billingPeriod', v_invoice.billing_period,
            'totalAmount', v_invoice.total_amount,
            'renderedText', v_rendered_text,
            'invoiceLink', v_invoice_link,
            'portalLink', v_portal_link,
            'queuedBy', 'manual_invoice_selection'
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
        send_type,
        schedule_type,
        payload
      )
      values (
        p_tenant_id,
        v_invoice.id,
        v_subscriber.id,
        'sms',
        'invoice_issued',
        v_subscriber.phone,
        'pending',
        'manual',
        'none',
        jsonb_build_object(
          'invoiceNo', v_invoice.invoice_no,
          'billingPeriod', v_invoice.billing_period,
          'totalAmount', v_invoice.total_amount,
          'renderedText', v_rendered_text,
          'invoiceLink', v_invoice_link,
          'portalLink', v_portal_link,
          'queuedBy', 'manual_invoice_selection'
        )
      )
      returning id into notification_id;
    end if;

    invoice_id := v_invoice.id;
    queued := true;
    return next;
  end loop;

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
    'notification_batch',
    array_to_string(p_invoice_ids, ','),
    'queue_selected_invoice_sms',
    jsonb_build_object(
      'invoiceCount', coalesce(array_length(p_invoice_ids, 1), 0),
      'linksPerInvoice', true
    )
  );
end;
$function$;

revoke execute on function public.powerhub_queue_selected_invoice_sms(bigint, bigint, bigint, bigint[]) from public, anon, authenticated;
grant execute on function public.powerhub_queue_selected_invoice_sms(bigint, bigint, bigint, bigint[]) to service_role;
