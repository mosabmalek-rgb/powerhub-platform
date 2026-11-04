-- Restore the Supabase settlement RPCs and enforce independent approval.
-- The creator may prepare and submit a settlement, but another user must approve it.
-- Locking preserves the original approver identity.

CREATE OR REPLACE FUNCTION public.powerhub_create_financial_settlement(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint,
  p_period_start timestamptz, p_period_end timestamptz,
  p_total_collected numeric, p_total_expenses numeric,
  p_actual_cash numeric DEFAULT NULL, p_notes text DEFAULT NULL
)
RETURNS TABLE(settlement_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id bigint;
  v_role text;
  v_profit numeric(14,2);
  v_difference numeric(14,2);
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_site_id IS NULL OR p_site_id < 1
     OR p_user_id IS NULL OR p_user_id < 1
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD' USING ERRCODE = 'P0001';
  END IF;

  IF p_total_collected IS NULL OR p_total_expenses IS NULL
     OR p_total_collected < 0 OR p_total_expenses < 0
     OR p_total_collected > 100000000000 OR p_total_expenses > 100000000000
     OR p_total_collected <> round(p_total_collected, 2)
     OR p_total_expenses <> round(p_total_expenses, 2)
     OR (p_actual_cash IS NOT NULL AND (
       p_actual_cash < 0 OR p_actual_cash > 100000000000
       OR p_actual_cash <> round(p_actual_cash, 2)
     ))
     OR (p_notes IS NOT NULL AND length(p_notes) > 2000) THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sites
    WHERE id = p_site_id AND tenant_id = p_tenant_id AND status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING ERRCODE = 'P0001';
  END IF;

  SELECT platform_role INTO v_role FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    p_site_id, hashtext(p_period_start::text || ':' || p_period_end::text)
  );

  IF EXISTS (
    SELECT 1 FROM public.financial_settlements
    WHERE tenant_id = p_tenant_id AND site_id = p_site_id
      AND status = 'locked'
      AND period_start <= p_period_end
      AND period_end >= p_period_start
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_PERIOD_OVERLAPS_LOCKED' USING ERRCODE = 'P0001';
  END IF;

  v_profit := round(p_total_collected - p_total_expenses, 2);
  v_difference := CASE
    WHEN p_actual_cash IS NULL THEN NULL
    ELSE round(p_actual_cash - v_profit, 2)
  END;

  INSERT INTO public.financial_settlements (
    tenant_id, site_id, period_start, period_end,
    total_collected, total_expenses, book_profit,
    actual_cash, difference, notes, created_by_user_id
  )
  VALUES (
    p_tenant_id, p_site_id, p_period_start, p_period_end,
    p_total_collected, p_total_expenses, v_profit,
    p_actual_cash, v_difference, p_notes, p_user_id
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  )
  VALUES (
    p_tenant_id, p_site_id, p_user_id, v_role,
    'financial_settlement', v_id::text, 'create',
    jsonb_build_object(
      'periodStart', p_period_start, 'periodEnd', p_period_end,
      'totalCollected', p_total_collected, 'totalExpenses', p_total_expenses,
      'bookProfit', v_profit, 'actualCash', p_actual_cash,
      'difference', v_difference, 'createdByUserId', p_user_id
    )
  );

  RETURN QUERY SELECT v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_set_financial_settlement_status(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint,
  p_settlement_id bigint, p_status text
)
RETURNS TABLE(settlement_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_settlement public.financial_settlements%rowtype;
  v_role text;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_site_id IS NULL OR p_site_id < 1
     OR p_user_id IS NULL OR p_user_id < 1
     OR p_settlement_id IS NULL OR p_settlement_id < 1
     OR p_status IS NULL
     OR p_status NOT IN ('submitted', 'approved', 'locked') THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_STATUS' USING ERRCODE = 'P0001';
  END IF;

  SELECT platform_role INTO v_role FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(p_settlement_id);

  SELECT * INTO v_settlement
  FROM public.financial_settlements
  WHERE id = p_settlement_id
    AND tenant_id = p_tenant_id
    AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_OUT_OF_SCOPE' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent retries never rewrite who approved or locked the settlement.
  IF v_settlement.status = p_status THEN
    RETURN QUERY SELECT v_settlement.id;
    RETURN;
  END IF;

  IF v_settlement.status = 'locked' THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_LOCKED' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'submitted' THEN
    IF v_settlement.status <> 'draft' THEN
      RAISE EXCEPTION 'INVALID_SETTLEMENT_TRANSITION' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_status = 'approved' THEN
    IF v_settlement.status <> 'submitted' THEN
      RAISE EXCEPTION 'SETTLEMENT_MUST_BE_SUBMITTED' USING ERRCODE = 'P0001';
    END IF;
    IF v_settlement.created_by_user_id = p_user_id THEN
      RAISE EXCEPTION 'SETTLEMENT_CREATOR_CANNOT_APPROVE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_status = 'locked' THEN
    IF v_settlement.status <> 'approved'
       OR v_settlement.approved_by_user_id IS NULL THEN
      RAISE EXCEPTION 'SETTLEMENT_MUST_BE_APPROVED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.financial_settlements
  SET status = p_status,
      approved_by_user_id = CASE
        WHEN p_status = 'approved' THEN p_user_id
        ELSE approved_by_user_id
      END,
      locked_at = CASE
        WHEN p_status = 'locked' THEN now()
        ELSE locked_at
      END,
      updated_at = now()
  WHERE id = p_settlement_id
    AND tenant_id = p_tenant_id
    AND site_id = p_site_id;

  INSERT INTO public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, before_data, after_data
  )
  VALUES (
    p_tenant_id, p_site_id, p_user_id, v_role,
    'financial_settlement', p_settlement_id::text, 'status_change',
    jsonb_build_object(
      'status', v_settlement.status,
      'approvedByUserId', v_settlement.approved_by_user_id,
      'lockedAt', v_settlement.locked_at
    ),
    jsonb_build_object(
      'status', p_status,
      'approvedByUserId', CASE
        WHEN p_status = 'approved' THEN p_user_id
        ELSE v_settlement.approved_by_user_id
      END,
      'lockedAt', CASE
        WHEN p_status = 'locked' THEN now()
        ELSE v_settlement.locked_at
      END
    )
  );

  RETURN QUERY SELECT p_settlement_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_create_financial_settlement(
  bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_financial_settlement(
  bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text
) TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_set_financial_settlement_status(
  bigint,bigint,bigint,bigint,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_set_financial_settlement_status(
  bigint,bigint,bigint,bigint,text
) TO service_role;

NOTIFY pgrst, 'reload schema';
