-- HR advance disbursements and repayments must carry their branch scope
-- at the instant the company-account movement is inserted. The source rows are
-- created afterwards, so the account_transactions BEFORE trigger cannot infer
-- site_id from them during the original INSERT.
--
-- Backfill legacy rows only when doing so cannot alter the opening cash balance
-- of an already locked settlement. Mismatched/ambiguous rows fail closed.

DO $preflight$
BEGIN
  IF to_regclass('public.employee_adjustments') IS NULL
     OR to_regclass('public.employee_adjustment_repayments') IS NULL
     OR to_regclass('public.account_transactions') IS NULL
     OR to_regclass('public.employees') IS NULL
     OR to_regclass('public.financial_settlements') IS NULL
     OR to_regclass('public.company_account_sites') IS NULL THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_SITE_SCOPE_PREREQUISITES_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_adjustments a
    JOIN public.employees e ON e.id=a.employee_id AND e.tenant_id=a.tenant_id
    JOIN public.account_transactions tx ON tx.id=a.disbursement_transaction_id AND tx.tenant_id=a.tenant_id
    WHERE a.adjustment_type='advance'
      AND COALESCE(a.site_id,e.site_id) IS NOT NULL
      AND tx.site_id IS NOT NULL
      AND tx.site_id IS DISTINCT FROM COALESCE(a.site_id,e.site_id)
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_DISBURSEMENT_SITE_MISMATCH_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_adjustment_repayments r
    JOIN public.account_transactions tx ON tx.id=r.account_transaction_id AND tx.tenant_id=r.tenant_id
    WHERE r.site_id IS NULL
       OR (tx.site_id IS NOT NULL AND tx.site_id IS DISTINCT FROM r.site_id)
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_REPAYMENT_SITE_MISMATCH_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_adjustments a
    JOIN public.employees e ON e.id=a.employee_id AND e.tenant_id=a.tenant_id
    JOIN public.account_transactions tx ON tx.id=a.disbursement_transaction_id AND tx.tenant_id=a.tenant_id
    WHERE a.adjustment_type='advance' AND tx.site_id IS NULL
      AND COALESCE(a.site_id,e.site_id) IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.financial_settlements fs
        WHERE fs.tenant_id=a.tenant_id
          AND fs.site_id=COALESCE(a.site_id,e.site_id)
          AND fs.status='locked' AND fs.period_end>=tx.occurred_at
      )
  ) OR EXISTS (
    SELECT 1 FROM public.employee_adjustment_repayments r
    JOIN public.account_transactions tx ON tx.id=r.account_transaction_id AND tx.tenant_id=r.tenant_id
    WHERE tx.site_id IS NULL
      AND EXISTS (
        SELECT 1 FROM public.financial_settlements fs
        WHERE fs.tenant_id=r.tenant_id AND fs.site_id=r.site_id
          AND fs.status='locked' AND fs.period_end>=tx.occurred_at
      )
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_SITE_BACKFILL_WOULD_CHANGE_LOCKED_SETTLEMENT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_adjustments a
    JOIN public.employees e ON e.id=a.employee_id AND e.tenant_id=a.tenant_id
    JOIN public.account_transactions tx ON tx.id=a.disbursement_transaction_id AND tx.tenant_id=a.tenant_id
    WHERE a.adjustment_type='advance'
      AND COALESCE(a.site_id,e.site_id) IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.company_account_sites cas
        WHERE cas.tenant_id=tx.tenant_id AND cas.account_id=tx.account_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.company_account_sites cas
        WHERE cas.tenant_id=tx.tenant_id AND cas.account_id=tx.account_id
          AND cas.site_id=COALESCE(a.site_id,e.site_id)
      )
  ) OR EXISTS (
    SELECT 1 FROM public.employee_adjustment_repayments r
    JOIN public.account_transactions tx ON tx.id=r.account_transaction_id AND tx.tenant_id=r.tenant_id
    WHERE EXISTS (
      SELECT 1 FROM public.company_account_sites cas
      WHERE cas.tenant_id=tx.tenant_id AND cas.account_id=tx.account_id
    )
      AND NOT EXISTS (
        SELECT 1 FROM public.company_account_sites cas
        WHERE cas.tenant_id=tx.tenant_id AND cas.account_id=tx.account_id
          AND cas.site_id=r.site_id
      )
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_SITE_BACKFILL_ACCOUNT_SCOPE_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_adjustments a
    JOIN public.account_transactions tx ON tx.id=a.disbursement_transaction_id AND tx.tenant_id=a.tenant_id
    WHERE a.adjustment_type='advance' AND a.site_id IS NULL AND tx.site_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.id=a.employee_id AND e.tenant_id=a.tenant_id AND e.site_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_SITE_UNKNOWN_REQUIRES_MANUAL_RECONCILIATION';
  END IF;
END
$preflight$;

UPDATE public.account_transactions tx
SET site_id=COALESCE(a.site_id,e.site_id)
FROM public.employee_adjustments a
JOIN public.employees e ON e.id=a.employee_id AND e.tenant_id=a.tenant_id
WHERE a.adjustment_type='advance'
  AND tx.id=a.disbursement_transaction_id
  AND tx.tenant_id=a.tenant_id
  AND tx.site_id IS NULL
  AND COALESCE(a.site_id,e.site_id) IS NOT NULL;

UPDATE public.account_transactions tx
SET site_id=r.site_id
FROM public.employee_adjustment_repayments r
WHERE tx.id=r.account_transaction_id
  AND tx.tenant_id=r.tenant_id
  AND tx.site_id IS NULL;

CREATE OR REPLACE FUNCTION public.powerhub_issue_employee_advance(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_employee_id bigint, p_advance_kind text, p_amount numeric, p_monthly_deduction numeric, p_account_id bigint, p_payment_date date, p_reason text, p_operation_key text)
 RETURNS TABLE(adjustment_id bigint, account_transaction_id bigint, remaining_amount numeric, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_existing public.employee_adjustments%rowtype;
  v_employee public.employees%rowtype;
  v_account public.company_accounts%rowtype;
  v_transaction_id bigint;
  v_adjustment_id bigint;
  v_balance numeric(14,2);
  v_role text;
  v_date date:=coalesce(p_payment_date,current_date);
  v_hash text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_employee_id is null
    or p_advance_kind not in ('salary_advance','employee_loan')
    or p_amount is null or p_amount<=0 or p_amount>100000000 or p_amount<>round(p_amount,2)
    or char_length(btrim(coalesce(p_reason,'')))<3 or char_length(p_reason)>255
    or nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>180
    or (p_advance_kind='employee_loan' and (p_monthly_deduction is null or p_monthly_deduction<=0 or p_monthly_deduction>p_amount or p_monthly_deduction<>round(p_monthly_deduction,2)))
    or (p_advance_kind='salary_advance' and p_monthly_deduction is not null) then
    raise exception 'INVALID_EMPLOYEE_ADVANCE_INPUT' using errcode='P0001';
  end if;
  v_hash:=md5(jsonb_build_object('siteId',p_site_id,'employeeId',p_employee_id,'kind',p_advance_kind,'amount',p_amount,'monthlyDeduction',p_monthly_deduction,'accountId',p_account_id,'date',v_date,'reason',btrim(p_reason))::text);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':employee-advance:'||p_operation_key,0));
  select e.* into v_existing from public.employee_adjustments e
  where e.tenant_id=p_tenant_id and e.adjustment_type='advance'
    and exists(select 1 from public.account_transactions t where t.id=e.disbursement_transaction_id and t.tenant_id=p_tenant_id and t.reference_no='EMP-ADV:'||p_operation_key)
  for update;
  if found then
    if v_existing.tenant_id<>p_tenant_id or v_existing.site_id<>p_site_id or v_existing.employee_id<>p_employee_id
      or v_existing.reason is distinct from btrim(p_reason) or v_existing.amount<>p_amount
      or v_existing.advance_kind is distinct from p_advance_kind
      or v_existing.monthly_deduction is distinct from p_monthly_deduction
      or v_existing.disbursement_account_id is distinct from p_account_id
      or v_existing.disbursed_at::date is distinct from v_date then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select v_existing.id,v_existing.disbursement_transaction_id,v_existing.remaining_amount,true;
    return;
  end if;
  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived' for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements fs where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked' and fs.period_start<=v_date::timestamptz and fs.period_end>=v_date::timestamptz) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  select e.* into v_employee from public.employees e
  where e.id=p_employee_id and e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null) for update;
  if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_employee.employment_status<>'active' then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_account_id);
  select a.* into v_account from public.company_accounts a where a.id=p_account_id and a.tenant_id=p_tenant_id and a.is_active for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites cs where cs.tenant_id=p_tenant_id and cs.account_id=p_account_id)
    and not exists(select 1 from public.company_account_sites cs where cs.tenant_id=p_tenant_id and cs.account_id=p_account_id and cs.site_id=p_site_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select v_account.opening_balance+coalesce(sum(case when t.transaction_type in ('deposit','transfer_in','collection') then t.amount else -t.amount end),0)
  into v_balance from public.account_transactions t where t.tenant_id=p_tenant_id and t.account_id=p_account_id;
  if v_balance<p_amount then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;
  insert into public.account_transactions(tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
  values(p_tenant_id,p_site_id,p_account_id,'withdrawal',p_amount,
    case when p_advance_kind='salary_advance' then 'سلفة مبكرة من راتب الموظف: ' else 'قرض موظف: ' end||v_employee.full_name,
    'EMP-ADV:'||p_operation_key,p_user_id,v_date::timestamp at time zone 'UTC')
  returning id into v_transaction_id;
  insert into public.employee_adjustments(tenant_id,employee_id,site_id,adjustment_type,advance_kind,monthly_deduction,amount,remaining_amount,reason,status,disbursement_account_id,disbursement_transaction_id,disbursed_at,created_by_user_id)
  values(p_tenant_id,p_employee_id,p_site_id,'advance',p_advance_kind,p_monthly_deduction,p_amount,p_amount,btrim(p_reason),'open',p_account_id,v_transaction_id,v_date::timestamp at time zone 'UTC',p_user_id)
  returning id into v_adjustment_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata)
  values(p_tenant_id,p_site_id,p_user_id,v_role,'employee_advance',v_adjustment_id::text,'disburse',
    jsonb_build_object('employeeId',p_employee_id,'kind',p_advance_kind,'amount',p_amount,'monthlyDeduction',p_monthly_deduction,'accountId',p_account_id,'transactionId',v_transaction_id,'paymentDate',v_date),
    jsonb_build_object('operationKey',p_operation_key,'payloadHash',v_hash));
  return query select v_adjustment_id,v_transaction_id,p_amount,false;
end;
$function$;


CREATE OR REPLACE FUNCTION public.powerhub_repay_employee_advance(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_adjustment_id bigint, p_account_id bigint, p_amount numeric, p_payment_date date, p_reference_no text, p_notes text, p_operation_key text)
 RETURNS TABLE(repayment_id bigint, adjustment_id bigint, remaining_amount numeric, account_transaction_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_adjustment public.employee_adjustments%rowtype;
  v_existing public.employee_adjustment_repayments%rowtype;
  v_account public.company_accounts%rowtype;
  v_transaction_id bigint;
  v_repayment_id bigint;
  v_balance numeric(14,2);
  v_remaining numeric(12,2);
  v_reserved numeric(12,2):=0;
  v_role text;
  v_date date:=coalesce(p_payment_date,current_date);
  v_hash text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_adjustment_id is null
    or p_amount is null or p_amount<=0 or p_amount>100000000 or p_amount<>round(p_amount,2)
    or nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>180
    or char_length(coalesce(p_reference_no,''))>100 or char_length(coalesce(p_notes,''))>500 then
    raise exception 'INVALID_ADVANCE_REPAYMENT' using errcode='P0001';
  end if;
  v_hash:=md5(jsonb_build_object('siteId',p_site_id,'adjustmentId',p_adjustment_id,'accountId',p_account_id,'amount',p_amount,'date',v_date,'reference',nullif(btrim(p_reference_no),''),'notes',nullif(btrim(p_notes),''))::text);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':employee-advance-repay:'||p_operation_key,0));
  select r.* into v_existing from public.employee_adjustment_repayments r where r.tenant_id=p_tenant_id and r.operation_key=p_operation_key for update;
  if found then
    if v_existing.operation_payload_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001'; end if;
    return query select v_existing.id,v_existing.adjustment_id,
      (select e.remaining_amount from public.employee_adjustments e where e.id=v_existing.adjustment_id),
      v_existing.account_transaction_id,true;
    return;
  end if;
  select a.* into v_adjustment from public.employee_adjustments a
  where a.id=p_adjustment_id and a.tenant_id=p_tenant_id and a.site_id=p_site_id and a.adjustment_type='advance' for update;
  if not found then raise exception 'ADVANCE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_adjustment.status<>'open' then raise exception 'ADVANCE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select coalesce(sum(a.amount),0) into v_reserved
    from public.payroll_adjustment_allocations a join public.payroll_runs r on r.id=a.payroll_run_id
    where a.adjustment_id=p_adjustment_id and r.status in ('draft','approved');
  if p_amount>greatest(v_adjustment.remaining_amount-v_reserved,0) then
    if v_reserved>0 then raise exception 'ADVANCE_BALANCE_RESERVED' using errcode='P0001'; end if;
    raise exception 'REPAYMENT_EXCEEDS_REMAINING' using errcode='P0001';
  end if;
  if exists(select 1 from public.financial_settlements fs where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked' and fs.period_start<=v_date::timestamptz and fs.period_end>=v_date::timestamptz) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(p_account_id);
  select a.* into v_account from public.company_accounts a where a.id=p_account_id and a.tenant_id=p_tenant_id and a.is_active for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites cs where cs.tenant_id=p_tenant_id and cs.account_id=p_account_id)
    and not exists(select 1 from public.company_account_sites cs where cs.tenant_id=p_tenant_id and cs.account_id=p_account_id and cs.site_id=p_site_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select v_account.opening_balance+coalesce(sum(case when t.transaction_type in ('deposit','transfer_in','collection') then t.amount else -t.amount end),0)
  into v_balance from public.account_transactions t where t.tenant_id=p_tenant_id and t.account_id=p_account_id;
  insert into public.account_transactions(tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
  values(p_tenant_id,p_site_id,p_account_id,'deposit',p_amount,'سداد سلفة/دين الموظف','EMP-REPAY:'||p_operation_key,p_user_id,v_date::timestamp at time zone 'UTC')
  returning id into v_transaction_id;
  v_remaining:=v_adjustment.remaining_amount-p_amount;
  update public.employee_adjustments set remaining_amount=v_remaining,status=case when v_remaining=0 then 'settled' else 'open' end,updated_at=now() where id=p_adjustment_id;
  insert into public.employee_adjustment_repayments(tenant_id,site_id,adjustment_id,repayment_method,amount,company_account_id,account_transaction_id,payment_date,reference_no,notes,operation_key,operation_payload_hash,created_by_user_id)
  values(p_tenant_id,p_site_id,p_adjustment_id,case v_account.account_type when 'cash' then 'cash' when 'bank_of_palestine' then 'bank' else 'wallet' end,p_amount,p_account_id,v_transaction_id,v_date,nullif(btrim(p_reference_no),''),nullif(btrim(p_notes),''),p_operation_key,v_hash,p_user_id)
  returning id into v_repayment_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata)
  values(p_tenant_id,p_site_id,p_user_id,v_role,'employee_advance',p_adjustment_id::text,'repay',
    jsonb_build_object('remainingAmount',v_adjustment.remaining_amount,'status',v_adjustment.status),
    jsonb_build_object('repaymentId',v_repayment_id,'amount',p_amount,'remainingAmount',v_remaining,'accountId',p_account_id,'transactionId',v_transaction_id,'paymentDate',v_date),
    jsonb_build_object('operationKey',p_operation_key,'payloadHash',v_hash));
  return query select v_repayment_id,p_adjustment_id,v_remaining,v_transaction_id,false;
end;
$function$;


REVOKE ALL ON FUNCTION public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)
  TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_repay_employee_advance(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_repay_employee_advance(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)
  TO service_role;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.employee_adjustments a
    JOIN public.employees e ON e.id=a.employee_id AND e.tenant_id=a.tenant_id
    JOIN public.account_transactions tx ON tx.id=a.disbursement_transaction_id AND tx.tenant_id=a.tenant_id
    WHERE a.adjustment_type='advance'
      AND COALESCE(a.site_id,e.site_id) IS NOT NULL
      AND tx.site_id IS DISTINCT FROM COALESCE(a.site_id,e.site_id)
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_DISBURSEMENT_SITE_POSTFLIGHT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_adjustment_repayments r
    JOIN public.account_transactions tx ON tx.id=r.account_transaction_id AND tx.tenant_id=r.tenant_id
    WHERE tx.site_id IS DISTINCT FROM r.site_id
  ) THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_REPAYMENT_SITE_POSTFLIGHT_FAILED';
  END IF;

  IF has_function_privilege('anon','public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.powerhub_repay_employee_advance(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_repay_employee_advance(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_repay_employee_advance(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'EMPLOYEE_ADVANCE_RPC_ACL_POSTFLIGHT_FAILED';
  END IF;
END
$postflight$;
