-- Expense classification is an accounting attribute, not a payment type.
-- Existing expenses and payroll-generated expenses default to operating.
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS expense_classification text NOT NULL DEFAULT 'operating';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.expenses'::regclass AND conname='expenses_classification_check') THEN
    ALTER TABLE public.expenses ADD CONSTRAINT expenses_classification_check
      CHECK (expense_classification IN ('operating','non_operating'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS expenses_tenant_site_classification_date_idx
  ON public.expenses(tenant_id,site_id,expense_classification,occurred_at DESC);

-- Perform existing idempotent creation and classification update atomically.
-- No second ledger transaction is ever created for classification changes.
CREATE OR REPLACE FUNCTION public.powerhub_create_expense_classified_idempotent(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_generator_id bigint,
  p_company_account_id bigint,p_category text,p_description text,p_amount numeric,
  p_reference_no text,p_client_operation_id uuid,p_expense_classification text
)
RETURNS TABLE(expense_id bigint,transaction_id bigint,replayed boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $body$
DECLARE v_created record;v_saved text;
BEGIN
  IF p_expense_classification NOT IN ('operating','non_operating')
    OR p_expense_classification IS NULL THEN
    RAISE EXCEPTION 'INVALID_EXPENSE_CLASSIFICATION' USING ERRCODE='P0001';
  END IF;
  IF p_client_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_EXPENSE_OPERATION_KEY' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_created
  FROM public.powerhub_create_expense_with_account_idempotent(
    p_tenant_id,p_site_id,p_user_id,p_generator_id,p_company_account_id,
    p_category,p_description,p_amount,p_reference_no,p_client_operation_id
  );
  IF v_created.expense_id IS NULL OR v_created.transaction_id IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_RESULT_MISSING' USING ERRCODE='P0001';
  END IF;
  IF v_created.replayed THEN
    SELECT e.expense_classification INTO v_saved
    FROM public.expenses e WHERE e.id=v_created.expense_id AND e.tenant_id=p_tenant_id
      AND e.site_id=p_site_id;
    IF v_saved IS DISTINCT FROM p_expense_classification THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='P0001';
    END IF;
  ELSE
    UPDATE public.expenses e SET expense_classification=p_expense_classification
    WHERE e.id=v_created.expense_id AND e.tenant_id=p_tenant_id
      AND e.site_id=p_site_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'EXPENSE_RESULT_MISSING' USING ERRCODE='P0001'; END IF;
    UPDATE public.audit_logs a SET after_data=COALESCE(a.after_data,'{}'::jsonb)
      || jsonb_build_object('expenseClassification',p_expense_classification)
    WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
      AND a.entity_type='expense' AND a.entity_id=v_created.expense_id::text
      AND a.action='create';
  END IF;
  RETURN QUERY SELECT v_created.expense_id,v_created.transaction_id,v_created.replayed;
END $body$;
REVOKE ALL ON FUNCTION public.powerhub_create_expense_classified_idempotent(
  bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_expense_classified_idempotent(
  bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid,text
) TO service_role;
NOTIFY pgrst,'reload schema';
