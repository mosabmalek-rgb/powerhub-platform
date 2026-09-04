create or replace function public.powerhub_create_generator_owner_subscription(
  p_actor_user_id bigint,
  p_auth_user_id uuid,
  p_tenant_name text,
  p_slug text,
  p_company_name text,
  p_owner_name text,
  p_identity_ciphertext text,
  p_identity_iv text,
  p_identity_last4 text,
  p_owner_phone text,
  p_owner_whatsapp text,
  p_owner_email text,
  p_site_name text,
  p_site_code text,
  p_plan text default 'starter',
  p_billing_cycle text default 'monthly',
  p_subscription_status text default 'trial',
  p_ends_at timestamptz default null
)
returns table (tenant_id bigint, owner_user_id bigint, site_id bigint, subscription_id bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_platform_role text;
  v_started_at timestamptz := now();
  v_ends_at timestamptz;
  v_tenant_id bigint;
  v_user_id bigint;
  v_site_id bigint;
  v_subscription_id bigint;
begin
  select platform_role into v_actor_platform_role from public.users where id = p_actor_user_id and role = 'admin' and account_status = 'active';
  if v_actor_platform_role is null then raise exception using errcode = '42501', message = 'حساب المنفذ لا يملك صلاحية إنشاء صاحب مولد.'; end if;
  if p_auth_user_id is null then raise exception using errcode = '22023', message = 'معرف حساب Supabase Auth مطلوب.'; end if;
  if p_plan not in ('starter', 'professional', 'enterprise') then raise exception using errcode = '22023', message = 'خطة الاشتراك غير صالحة.'; end if;
  if p_billing_cycle not in ('monthly', 'yearly') then raise exception using errcode = '22023', message = 'دورة الفوترة غير صالحة.'; end if;
  if p_subscription_status not in ('trial', 'active', 'overdue', 'suspended', 'cancelled') then raise exception using errcode = '22023', message = 'حالة الاشتراك غير صالحة.'; end if;
  if exists (select 1 from public.tenant_owner_profiles where phone = p_owner_phone) then raise exception using errcode = '23505', message = 'رقم هاتف صاحب المولد مستخدم بالفعل.'; end if;
  if exists (select 1 from public.tenant_owner_profiles where email = lower(p_owner_email)) then raise exception using errcode = '23505', message = 'البريد الإلكتروني لصاحب المولد مستخدم بالفعل.'; end if;
  if exists (select 1 from public.tenants where slug = p_slug) then raise exception using errcode = '23505', message = 'معرف مساحة صاحب المولد مستخدم بالفعل.'; end if;
  v_ends_at := coalesce(p_ends_at, v_started_at + case when p_billing_cycle = 'yearly' then interval '1 year' else interval '1 month' end);
  insert into public.users (auth_user_id, name, email, login_method, role, account_status, must_change_password, temporary_password_issued_at, last_signed_in)
  values (p_auth_user_id, p_owner_name, lower(p_owner_email), 'supabase', 'user', 'active', true, v_started_at, v_started_at) returning id into v_user_id;
  insert into public.tenants (name, slug, status, plan) values (p_tenant_name, p_slug, case when p_subscription_status = 'cancelled' then 'suspended' else 'active' end, p_plan) returning id into v_tenant_id;
  insert into public.tenant_owner_profiles (tenant_id, owner_user_id, full_name, phone, whatsapp_number, email, company_name, identity_number_ciphertext, identity_number_iv, identity_number_last4, invited_at, claimed_at)
  values (v_tenant_id, v_user_id, p_owner_name, p_owner_phone, nullif(p_owner_whatsapp, ''), lower(p_owner_email), nullif(p_company_name, ''), p_identity_ciphertext, p_identity_iv, p_identity_last4, v_started_at, v_started_at);
  insert into public.sites (tenant_id, name, code, status) values (v_tenant_id, p_site_name, p_site_code, 'active') returning id into v_site_id;
  insert into public.tenant_members (tenant_id, user_id, role, is_active, membership_status) values (v_tenant_id, v_user_id, 'owner', true, 'active');
  insert into public.staff_profiles (tenant_id, site_id, user_id, role, is_active) values (v_tenant_id, v_site_id, v_user_id, 'owner', true);
  insert into public.tenant_subscriptions (tenant_id, plan, status, billing_cycle, started_at, ends_at, auto_renew, renewal_count, notes)
  values (v_tenant_id, p_plan, p_subscription_status, p_billing_cycle, v_started_at, v_ends_at, false, 0, null) returning id into v_subscription_id;
  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data, metadata)
  values (v_tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role, 'tenant_subscription', v_subscription_id::text, 'platform_admin_create_generator_owner_subscription', jsonb_build_object('tenantId', v_tenant_id, 'ownerUserId', v_user_id, 'plan', p_plan, 'status', p_subscription_status), jsonb_build_object('ownerEmail', lower(p_owner_email), 'ownerPhoneLast4', right(p_owner_phone, 4)));
  return query select v_tenant_id, v_user_id, v_site_id, v_subscription_id;
end;
$$;
revoke all on function public.powerhub_create_generator_owner_subscription(bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_create_generator_owner_subscription(bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text) to service_role;
