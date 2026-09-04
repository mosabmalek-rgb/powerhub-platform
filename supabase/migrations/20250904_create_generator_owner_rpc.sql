-- ============================================================================
-- RPC: powerhub_create_generator_owner
-- Purpose: إنشاء صاحب مولد جديد مع مشترك وفرع ومولد - عملية ذرية
-- ============================================================================

CREATE OR REPLACE FUNCTION powerhub_create_generator_owner(
  p_actor_user_id INT,
  p_tenant_name VARCHAR(160),
  p_slug VARCHAR(80),
  p_company_name VARCHAR(180),
  p_owner_name VARCHAR(180),
  p_identity_ciphertext TEXT,
  p_identity_iv VARCHAR(64),
  p_identity_last4 VARCHAR(4),
  p_owner_phone VARCHAR(30),
  p_owner_whatsapp VARCHAR(30),
  p_owner_email VARCHAR(320),
  p_owner_user_id INT,
  p_site_name VARCHAR(160),
  p_site_code VARCHAR(50),
  p_city VARCHAR(100),
  p_generator_name VARCHAR(160),
  p_generator_code VARCHAR(50),
  p_generator_capacity_kw DECIMAL(12, 3),
  p_generator_fuel_type VARCHAR(20),
  p_plan VARCHAR(20),
  p_subscription_status VARCHAR(20),
  p_billing_cycle VARCHAR(20),
  p_ends_at TIMESTAMP,
  p_auto_renew BOOLEAN,
  p_notes TEXT
)
RETURNS TABLE(
  tenant_id INT,
  site_id INT,
  generator_id INT,
  status VARCHAR(20),
  message VARCHAR(500)
) AS $$
DECLARE
  v_tenant_id INT;
  v_site_id INT;
  v_generator_id INT;
  v_started_at TIMESTAMP;
BEGIN
  -- التحقق من البيانات المدخلة
  IF p_tenant_name IS NULL OR p_tenant_name = '' THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'error'::VARCHAR, 'اسم صاحب المولد مطلوب'::VARCHAR;
    RETURN;
  END IF;

  IF p_owner_phone IS NULL OR p_owner_phone = '' THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'error'::VARCHAR, 'رقم هاتف صاحب المولد مطلوب'::VARCHAR;
    RETURN;
  END IF;

  IF p_generator_name IS NULL OR p_generator_name = '' THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'error'::VARCHAR, 'اسم المولد مطلوب'::VARCHAR;
    RETURN;
  END IF;

  -- التحقق من عدم تكرار رقم الهاتف
  IF EXISTS(SELECT 1 FROM tenant_owner_profiles WHERE phone = p_owner_phone) THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'error'::VARCHAR, 'رقم هاتف صاحب المولد مستخدم بالفعل'::VARCHAR;
    RETURN;
  END IF;

  -- التحقق من عدم تكرار اسم المولد
  IF EXISTS(SELECT 1 FROM generators WHERE name = p_generator_name) THEN
    RETURN QUERY SELECT NULL, NULL, NULL, 'error'::VARCHAR, 'اسم المولد مستخدم بالفعل'::VARCHAR;
    RETURN;
  END IF;

  -- التحقق من عدم تكرار البريد الإلكتروني
  IF p_owner_email IS NOT NULL AND p_owner_email != '' THEN
    IF EXISTS(SELECT 1 FROM tenant_owner_profiles WHERE email = LOWER(p_owner_email)) THEN
      RETURN QUERY SELECT NULL, NULL, NULL, 'error'::VARCHAR, 'البريد الإلكتروني لصاحب المولد مستخدم بالفعل'::VARCHAR;
      RETURN;
    END IF;
  END IF;

  -- ابدأ المعاملة الذرية
  BEGIN
    v_started_at := NOW();

    -- 1. إنشاء المستأجر (صاحب المولد)
    INSERT INTO tenants (name, slug, plan, status, created_at, updated_at)
    VALUES (
      p_tenant_name,
      p_slug,
      p_plan,
      CASE WHEN p_subscription_status IN ('suspended', 'cancelled') THEN 'suspended' ELSE 'active' END,
      v_started_at,
      v_started_at
    )
    RETURNING id INTO v_tenant_id;

    -- 2. إنشاء م��ف مالك المولد
    INSERT INTO tenant_owner_profiles (
      tenant_id,
      owner_user_id,
      full_name,
      phone,
      whatsapp_number,
      email,
      company_name,
      identity_number_ciphertext,
      identity_number_iv,
      identity_number_last4,
      invited_at,
      claimed_at,
      created_at,
      updated_at
    )
    VALUES (
      v_tenant_id,
      p_owner_user_id,
      p_owner_name,
      p_owner_phone,
      p_owner_whatsapp,
      CASE WHEN p_owner_email IS NOT NULL AND p_owner_email != '' THEN LOWER(p_owner_email) ELSE NULL END,
      p_company_name,
      p_identity_ciphertext,
      p_identity_iv,
      p_identity_last4,
      CASE WHEN p_owner_user_id IS NULL THEN v_started_at ELSE NULL END,
      CASE WHEN p_owner_user_id IS NOT NULL THEN v_started_at ELSE NULL END,
      v_started_at,
      v_started_at
    );

    -- 3. إنشاء الاشتراك
    INSERT INTO tenant_subscriptions (
      tenant_id,
      plan,
      status,
      billing_cycle,
      started_at,
      ends_at,
      auto_renew,
      notes,
      created_at,
      updated_at
    )
    VALUES (
      v_tenant_id,
      p_plan,
      p_subscription_status,
      p_billing_cycle,
      v_started_at,
      p_ends_at,
      p_auto_renew,
      p_notes,
      v_started_at,
      v_started_at
    );

    -- 4. إنشاء الفرع (الموقع)
    INSERT INTO sites (tenant_id, name, code, city, status, anomaly_alert_percent, invoice_due_days, created_at, updated_at)
    VALUES (
      v_tenant_id,
      p_site_name,
      p_site_code,
      p_city,
      'active',
      50,
      14,
      v_started_at,
      v_started_at
    )
    RETURNING id INTO v_site_id;

    -- 5. إنشاء إعدادات بوابة الفرع
    INSERT INTO site_portal_settings (tenant_id, site_id, portal_code, display_name, primary_color, accent_color, is_enabled, created_at, updated_at)
    VALUES (
      v_tenant_id,
      v_site_id,
      LOWER(p_site_code),
      p_site_name,
      '#0D1117',
      '#F5B800',
      true,
      v_started_at,
      v_started_at
    );

    -- 6. إنشاء المولد
    INSERT INTO generators (
      tenant_id,
      site_id,
      code,
      name,
      rated_capacity_kw,
      fuel_type,
      fuel_level_liters,
      operating_hours,
      status,
      created_at,
      updated_at
    )
    VALUES (
      v_tenant_id,
      v_site_id,
      p_generator_code,
      p_generator_name,
      p_generator_capacity_kw,
      p_generator_fuel_type,
      0,
      0,
      'pending',
      v_started_at,
      v_started_at
    )
    RETURNING id INTO v_generator_id;

    -- 7. إذا كان هناك مستخدم مالك، ربطه
    IF p_owner_user_id IS NOT NULL THEN
      INSERT INTO tenant_members (
        tenant_id,
        user_id,
        role,
        is_active,
        membership_status,
        created_at,
        updated_at
      )
      VALUES (v_tenant_id, p_owner_user_id, 'owner', true, 'active', v_started_at, v_started_at)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        role = 'owner',
        is_active = true,
        membership_status = 'active',
        updated_at = v_started_at;

      INSERT INTO staff_profiles (
        tenant_id,
        site_id,
        user_id,
        role,
        is_active,
        created_at,
        updated_at
      )
      VALUES (v_tenant_id, v_site_id, p_owner_user_id, 'owner', true, v_started_at, v_started_at)
      ON CONFLICT (user_id, site_id, role) DO UPDATE SET
        is_active = true,
        updated_at = v_started_at;
    END IF;

    -- 8. تسجيل عملية التدقيق
    INSERT INTO audit_logs (
      tenant_id,
      site_id,
      user_id,
      entity_type,
      entity_id,
      action,
      after_data,
      created_at
    )
    VALUES (
      v_tenant_id,
      v_site_id,
      p_actor_user_id,
      'generator',
      v_generator_id::TEXT,
      'platform_admin_create_pending_generator_owner',
      jsonb_build_object(
        'tenantName', p_tenant_name,
        'ownerName', p_owner_name,
        'generatorName', p_generator_name,
        'generatorCode', p_generator_code,
        'generatorStatus', 'pending',
        'plan', p_plan,
        'subscriptionStatus', p_subscription_status
      ),
      v_started_at
    );

    -- عودة النتيجة الناجحة
    RETURN QUERY SELECT 
      v_tenant_id,
      v_site_id,
      v_generator_id,
      'success'::VARCHAR,
      'تم إنشاء صاحب المولد بنجاح'::VARCHAR;

  EXCEPTION WHEN OTHERS THEN
    -- حالة الخطأ
    RETURN QUERY SELECT 
      NULL,
      NULL,
      NULL,
      'error'::VARCHAR,
      ('حدث خطأ في إنشاء صاحب المولد: ' || SQLERRM)::VARCHAR;
END;

END $$
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

-- منح الصلاحيات
GRANT EXECUTE ON FUNCTION powerhub_create_generator_owner(
  INT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DECIMAL, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMP, BOOLEAN, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION powerhub_create_generator_owner(
  INT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DECIMAL, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMP, BOOLEAN, TEXT
) TO service_role;

-- ============================================================================
-- تعليقات توثيق
-- ============================================================================
COMMENT ON FUNCTION powerhub_create_generator_owner(INT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DECIMAL, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMP, BOOLEAN, TEXT) IS 'إنشاء صاحب مولد جديد مع جميع البيانات المرتبطة به - عملية ذرية آمنة';
