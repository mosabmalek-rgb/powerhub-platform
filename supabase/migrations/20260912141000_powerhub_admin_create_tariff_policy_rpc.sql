create or replace function public.powerhub_admin_create_tariff_policy(
  p_actor_user_id bigint,
  p_minimum_price_per_kwh numeric,
  p_maximum_price_per_kwh numeric,
  p_effective_from timestamptz,
  p_notification_requested boolean default false,
  p_notes text default null
)
returns table(success boolean, policy_id bigint, queued_notifications integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_policy_id bigint;
  v_queued integer := 0;
  v_owner_site record;
  v_channel text;
begin
  if p_minimum_price_per_kwh < 0 or p_maximum_price_per_kwh <= 0 or p_maximum_price_per_kwh < p_minimum_price_per_kwh then
    raise exception 'INVALID_TARIFF_RANGE';
  end if;

  if p_effective_from is null then
    raise exception 'INVALID_EFFECTIVE_FROM';
  end if;

  if p_notes is not null and char_length(p_notes) > 2000 then
    raise exception 'INVALID_NOTES';
  end if;

  select *
    into v_actor
    from public.users
   where id = p_actor_user_id
     and role = 'admin'
     and platform_role in ('platform_owner', 'platform_admin')
     and account_status = 'active'
   for update;

  if not found then
    raise exception 'FORBIDDEN';
  end if;

  insert into public.platform_tariff_policies(
    minimum_price_per_kwh,
    maximum_price_per_kwh,
    effective_from,
    notification_requested,
    notes,
    created_by_user_id,
    created_at
  )
  values (
    p_minimum_price_per_kwh,
    p_maximum_price_per_kwh,
    p_effective_from,
    p_notification_requested,
    p_notes,
    v_actor.id,
    now()
  )
  returning id into v_policy_id;

  if p_notification_requested then
    for v_owner_site in
      select top_profile.tenant_id,
             top_profile.phone,
             first_site.id as site_id
        from public.tenant_owner_profiles top_profile
        join lateral (
          select s.id
            from public.sites s
           where s.tenant_id = top_profile.tenant_id
             and s.status <> 'archived'
           order by s.id asc
           limit 1
        ) first_site on true
       where top_profile.phone is not null
         and length(trim(top_profile.phone)) > 0
       order by top_profile.tenant_id
    loop
      for v_channel in
        select tmc.channel
          from public.tenant_messaging_configurations tmc
         where tmc.tenant_id = v_owner_site.tenant_id
           and tmc.is_active = true
           and tmc.channel in ('whatsapp', 'sms')
         order by case when tmc.channel = 'whatsapp' then 0 else 1 end
      loop
        insert into public.notification_messages(
          tenant_id,
          channel,
          event_type,
          recipient,
          status,
          payload,
          created_at,
          updated_at
        )
        values (
          v_owner_site.tenant_id,
          v_channel,
          'service_alert',
          trim(v_owner_site.phone),
          'pending',
          jsonb_build_object(
            'type', 'platform_tariff_policy',
            'policyId', v_policy_id,
            'minimumPricePerKwh', p_minimum_price_per_kwh,
            'maximumPricePerKwh', p_maximum_price_per_kwh,
            'effectiveFrom', p_effective_from,
            'siteId', v_owner_site.site_id
          ),
          now(),
          now()
        );
        v_queued := v_queued + 1;
      end loop;

      if not exists (
        select 1
          from public.tenant_messaging_configurations tmc
         where tmc.tenant_id = v_owner_site.tenant_id
           and tmc.is_active = true
           and tmc.channel in ('whatsapp', 'sms')
      ) then
        insert into public.notification_messages(
          tenant_id,
          channel,
          event_type,
          recipient,
          status,
          payload,
          created_at,
          updated_at
        )
        values (
          v_owner_site.tenant_id,
          'whatsapp',
          'service_alert',
          trim(v_owner_site.phone),
          'pending',
          jsonb_build_object(
            'type', 'platform_tariff_policy',
            'policyId', v_policy_id,
            'minimumPricePerKwh', p_minimum_price_per_kwh,
            'maximumPricePerKwh', p_maximum_price_per_kwh,
            'effectiveFrom', p_effective_from,
            'siteId', v_owner_site.site_id,
            'notificationFallback', true
          ),
          now(),
          now()
        );
        v_queued := v_queued + 1;
      end if;
    end loop;
  end if;

  insert into public.platform_security_events(
    event_type,
    severity,
    status,
    title,
    details,
    metadata,
    created_by_user_id
  )
  values (
    'security_change',
    'info',
    'success',
    'تحديث التسعيرة الرسمية',
    'تم إنشاء سياسة تسعير جديدة عبر مسار إدارة المنصة.',
    jsonb_build_object(
      'policyId', v_policy_id,
      'minimumPricePerKwh', p_minimum_price_per_kwh,
      'maximumPricePerKwh', p_maximum_price_per_kwh,
      'effectiveFrom', p_effective_from,
      'notificationRequested', p_notification_requested,
      'queuedNotifications', v_queued
    ),
    v_actor.id
  );

  return query select true, v_policy_id, v_queued;
end;
$$;

revoke all on function public.powerhub_admin_create_tariff_policy(bigint, numeric, numeric, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_create_tariff_policy(bigint, numeric, numeric, timestamptz, boolean, text) to service_role;
