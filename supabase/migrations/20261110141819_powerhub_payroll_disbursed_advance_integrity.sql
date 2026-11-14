-- A38: real payroll advance deduction must have provable original disbursement.
-- This is the deployed Staging migration 20261110141819. No test-fixture
-- repair belongs in this migration; these financial guards apply to every tenant.
-- Existing RPC ACLs for the three replaced functions are preserved.
CREATE OR REPLACE FUNCTION public.powerhub_payroll_advance_allocations_valid(p_tenant_id bigint, p_site_id bigint, p_payroll_run_id bigint, p_period text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT p_tenant_id>0 AND p_site_id>0 AND p_payroll_run_id>0
 AND p_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 AND EXISTS (SELECT 1 FROM public.payroll_runs r
   WHERE r.id=p_payroll_run_id AND r.tenant_id=p_tenant_id AND r.site_id=p_site_id
     AND r.period=p_period)
 AND NOT EXISTS (
  SELECT 1 FROM public.payroll_items pi
  LEFT JOIN LATERAL(
    SELECT coalesce(sum(pa.amount),0) amt,
      coalesce(bool_and(
        adj.id IS NOT NULL
        AND adj.tenant_id=p_tenant_id AND adj.site_id=p_site_id
        AND adj.employee_id=pi.employee_id AND adj.adjustment_type='advance'
        AND adj.disbursed_at IS NOT NULL
        AND adj.disbursement_transaction_id IS NOT NULL
        AND (adj.disbursed_at AT TIME ZONE 'Asia/Gaza')::date
          < ((p_period||'-01')::date+interval '1 month')::date
        AND tx.id IS NOT NULL AND tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
        AND tx.account_id=adj.disbursement_account_id
        AND tx.transaction_type='withdrawal' AND tx.amount=adj.amount
        AND tx.reference_no LIKE 'EMP-ADV:%'
      ),true) verified
    FROM public.payroll_adjustment_allocations pa
    LEFT JOIN public.employee_adjustments adj ON adj.id=pa.adjustment_id
    LEFT JOIN public.account_transactions tx ON tx.id=adj.disbursement_transaction_id
    WHERE pa.payroll_run_id=pi.payroll_run_id
      AND (adj.employee_id=pi.employee_id OR adj.id IS NULL)
  ) a ON TRUE
  WHERE pi.payroll_run_id=p_payroll_run_id
    AND (pi.advance_deduction IS NULL OR pi.advance_deduction<0
      OR pi.advance_deduction<>a.amt OR NOT a.verified)
 )
 AND NOT EXISTS (
   SELECT 1 FROM public.payroll_adjustment_allocations pa
   LEFT JOIN public.employee_adjustments adj ON adj.id=pa.adjustment_id
   LEFT JOIN public.payroll_items pi ON pi.payroll_run_id=pa.payroll_run_id
     AND pi.employee_id=adj.employee_id
   WHERE pa.payroll_run_id=p_payroll_run_id AND pi.id IS NULL
 );
$function$
;
REVOKE ALL ON FUNCTION public.powerhub_payroll_advance_allocations_valid(bigint,bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_payroll_advance_allocations_valid(bigint,bigint,bigint,text) TO service_role;
CREATE OR REPLACE FUNCTION public.powerhub_create_payroll_draft(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_period text, p_items jsonb)
 RETURNS TABLE(payroll_run_id bigint, total_net numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_period_start timestamptz; v_period_end timestamptz; v_payroll_run_id bigint; v_total_gross numeric(14,2):=0;
  v_total_deductions numeric(14,2):=0; v_total_net numeric(14,2):=0; v_base numeric(12,2); v_open_advances numeric(12,2);
  v_advance_deduction numeric(12,2); v_advance_reserve numeric(12,2); v_net numeric(12,2); v_calculated_items jsonb:='[]'::jsonb;
  v_role text; v_item record; v_adjustment record; v_reserved numeric(12,2); v_available numeric(12,2); v_to_allocate numeric(12,2);
begin
  if p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'INVALID_PAYROLL_DRAFT_INPUT' using errcode='P0001';
  end if;
  v_period_start := (p_period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':payroll-draft:'||p_site_id::text,0));
  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if exists (select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start <= v_period_end and period_end >= v_period_start) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(employee_id bigint,extra_amount numeric,advance_deduction numeric,other_deduction numeric,notes text) group by employee_id having count(*) > 1) then raise exception 'DUPLICATE_PAYROLL_EMPLOYEE' using errcode='P0001'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(employee_id bigint,extra_amount numeric,advance_deduction numeric,other_deduction numeric,notes text) where employee_id is null or coalesce(extra_amount,-1)<0 or coalesce(advance_deduction,-1)<0 or coalesce(other_deduction,-1)<0 or coalesce(extra_amount,0)>100000000 or coalesce(advance_deduction,0)<>0 or coalesce(advance_deduction,0)>100000000 or coalesce(other_deduction,0)>100000000 or char_length(coalesce(notes,''))>500) then raise exception 'INVALID_PAYROLL_DRAFT_INPUT' using errcode='P0001'; end if;
  if exists (select 1 from public.payroll_runs where tenant_id=p_tenant_id and site_id=p_site_id and period=p_period and status<>'cancelled') then raise exception 'PAYROLL_PERIOD_ALREADY_EXISTS' using errcode='P0001'; end if;
  if exists (select 1 from public.payroll_runs where tenant_id=p_tenant_id and site_id=p_site_id and status in ('draft','approved')) then raise exception 'PAYROLL_OPEN_RUN_EXISTS' using errcode='P0001'; end if;
  for v_item in select * from jsonb_to_recordset(p_items) as x(employee_id bigint,extra_amount numeric,advance_deduction numeric,other_deduction numeric,notes text)
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':employee-payroll:'||v_item.employee_id::text,0));
    select base_wage into v_base from public.employees where id=v_item.employee_id and tenant_id=p_tenant_id and (site_id=p_site_id or site_id is null) and employment_status='active' for share;
    if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
    select coalesce(sum(case when advance_kind='salary_advance' or advance_kind is null then remaining_amount when advance_kind='employee_loan' then least(remaining_amount,coalesce(monthly_deduction,remaining_amount)) else 0 end),0) into v_open_advances from public.employee_adjustments where tenant_id=p_tenant_id and employee_id=v_item.employee_id and site_id=p_site_id and adjustment_type='advance' and status='open' and disbursed_at is not null and disbursement_transaction_id is not null;
    select v_open_advances - coalesce(sum(a.amount),0) into v_open_advances from public.payroll_adjustment_allocations a join public.payroll_runs r on r.id=a.payroll_run_id and r.status in ('draft','approved') join public.employee_adjustments e on e.id=a.adjustment_id where e.tenant_id=p_tenant_id and e.employee_id=v_item.employee_id and e.site_id=p_site_id and e.adjustment_type='advance' and e.status='open' and e.disbursed_at is not null and e.disbursement_transaction_id is not null;
    v_open_advances := greatest(coalesce(v_open_advances,0),0);
    v_advance_deduction := least(v_item.advance_deduction + v_open_advances, greatest(v_base + v_item.extra_amount - v_item.other_deduction,0));
    v_advance_reserve := least(v_advance_deduction, v_open_advances);
    v_net := v_base + v_item.extra_amount - v_advance_deduction - v_item.other_deduction;
    if v_net < 0 then raise exception 'NEGATIVE_PAYROLL_NET' using errcode='P0001'; end if;
    v_total_gross := v_total_gross + v_base + v_item.extra_amount; v_total_deductions := v_total_deductions + v_advance_deduction + v_item.other_deduction; v_total_net := v_total_net + v_net;
    v_calculated_items := v_calculated_items || jsonb_build_array(jsonb_build_object('employeeId',v_item.employee_id,'baseAmount',v_base,'extraAmount',v_item.extra_amount,'advanceDeduction',v_advance_deduction,'advanceReserve',v_advance_reserve,'otherDeduction',v_item.other_deduction,'netAmount',v_net,'notes',nullif(btrim(v_item.notes),'')));
  end loop;
  insert into public.payroll_runs(tenant_id,site_id,period,status,total_gross,total_deductions,total_net,created_by_user_id) values(p_tenant_id,p_site_id,p_period,'draft',v_total_gross,v_total_deductions,v_total_net,p_user_id) returning id into v_payroll_run_id;
  insert into public.payroll_items(payroll_run_id,employee_id,base_amount,extra_amount,advance_deduction,other_deduction,net_amount,notes)
    select v_payroll_run_id,(item->>'employeeId')::bigint,(item->>'baseAmount')::numeric,(item->>'extraAmount')::numeric,(item->>'advanceDeduction')::numeric,(item->>'otherDeduction')::numeric,(item->>'netAmount')::numeric,item->>'notes' from jsonb_array_elements(v_calculated_items) as item;
  for v_item in select item from jsonb_array_elements(v_calculated_items) as item loop
    v_to_allocate := (v_item.item->>'advanceReserve')::numeric;
    for v_adjustment in select id,remaining_amount,advance_kind,monthly_deduction from public.employee_adjustments where tenant_id=p_tenant_id and employee_id=(v_item.item->>'employeeId')::bigint and site_id=p_site_id and adjustment_type='advance' and status='open' and disbursed_at is not null and disbursement_transaction_id is not null order by case when advance_kind='salary_advance' or advance_kind is null then 0 else 1 end,created_at,id for share loop
      exit when v_to_allocate <= 0;
      select coalesce(sum(a.amount),0) into v_reserved from public.payroll_adjustment_allocations a join public.payroll_runs r on r.id=a.payroll_run_id and r.status in ('draft','approved') where a.adjustment_id=v_adjustment.id;
      v_available := greatest((case when v_adjustment.advance_kind='employee_loan' then least(v_adjustment.remaining_amount,coalesce(v_adjustment.monthly_deduction,v_adjustment.remaining_amount)) else v_adjustment.remaining_amount end)-v_reserved,0);
      if v_available > 0 then
        v_reserved := least(v_available,v_to_allocate);
        insert into public.payroll_adjustment_allocations(payroll_run_id,adjustment_id,amount) values(v_payroll_run_id,v_adjustment.id,v_reserved);
        v_to_allocate := v_to_allocate-v_reserved;
      end if;
    end loop;
    if v_to_allocate > 0 then raise exception 'ADVANCE_RESERVATION_CONFLICT' using errcode='P0001'; end if;
  end loop;
  IF NOT public.powerhub_payroll_advance_allocations_valid(p_tenant_id,p_site_id,v_payroll_run_id,p_period) THEN
    RAISE EXCEPTION 'PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID' USING ERRCODE='23514';
  END IF;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',v_payroll_run_id::text,'create',jsonb_build_object('period',p_period,'itemCount',jsonb_array_length(v_calculated_items),'totalGross',v_total_gross,'totalDeductions',v_total_deductions,'totalNet',v_total_net,'advanceReservations',true));
  return query select v_payroll_run_id,v_total_net;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_approve_payroll(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_payroll_run_id bigint)
 RETURNS TABLE(payroll_run_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_period text;v_status text;v_creator bigint;v_approver bigint;
 v_period_start timestamptz;v_period_end timestamptz;v_role text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_user_id IS NULL OR p_user_id<=0
    OR p_payroll_run_id IS NULL OR p_payroll_run_id<=0 THEN
   RAISE EXCEPTION 'PAYROLL_APPROVAL_INVALID_SCOPE' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   p_tenant_id::text||':payroll-approve:'||p_site_id::text||':'||p_payroll_run_id::text,0));
 SELECT p.period,p.status,p.created_by_user_id,p.approved_by_user_id
 INTO v_period,v_status,v_creator,v_approver
 FROM public.payroll_runs p
 WHERE p.id=p_payroll_run_id AND p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_RUN_OUT_OF_SCOPE' USING ERRCODE='P0001';
 END IF;
 SELECT u.platform_role INTO v_role
 FROM public.users u
 JOIN public.tenant_members m ON m.user_id=u.id
 WHERE u.id=p_user_id AND u.account_status='active'
    AND m.tenant_id=p_tenant_id AND m.is_active
    AND m.membership_status='active'
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
 LIMIT 1;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_APPROVER_OUT_OF_TENANT'
     USING ERRCODE='22023';
 END IF;
 IF v_creator=p_user_id THEN
   RAISE EXCEPTION 'PAYROLL_APPROVER_SAME_AS_CREATOR'
     USING ERRCODE='22023';
 END IF;
 -- Network retries return the identical result, with no second audit event.
 -- A different actor cannot silently claim or overwrite an existing approval.
 IF v_status IN ('approved','paid') THEN
   IF v_approver IS DISTINCT FROM p_user_id THEN
     RAISE EXCEPTION 'PAYROLL_APPROVAL_REPLAY_CONFLICT'
       USING ERRCODE='23505';
   END IF;
   RETURN QUERY SELECT p_payroll_run_id;
   RETURN;
 END IF;
 IF v_status<>'draft' THEN
   RAISE EXCEPTION 'PAYROLL_RUN_NOT_DRAFT' USING ERRCODE='P0001';
 END IF;
 v_period_start:=(v_period||'-01')::date;
 v_period_end:=v_period_start+interval '1 month'-interval '1 microsecond';
 IF EXISTS(
   SELECT 1 FROM public.financial_settlements s
   WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
     AND s.status='locked'
     AND s.period_start<=v_period_end AND s.period_end>=v_period_start
 ) THEN
   RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001';
 END IF;
 IF NOT public.powerhub_payroll_advance_allocations_valid(p_tenant_id,p_site_id,p_payroll_run_id,v_period) THEN
   RAISE EXCEPTION 'PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID' USING ERRCODE='23514';
 END IF;
 UPDATE public.payroll_runs
 SET status='approved',approved_by_user_id=p_user_id,updated_at=now()
 WHERE id=p_payroll_run_id AND tenant_id=p_tenant_id AND site_id=p_site_id
   AND status='draft';
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_APPROVAL_CONCURRENT_STATUS_CHANGE'
      USING ERRCODE='23505';
 END IF;
 INSERT INTO public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
 ) VALUES(
   p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',
   p_payroll_run_id::text,'approve',
   jsonb_build_object('period',v_period,'previousStatus',v_status,
     'status','approved','sourceCreatorId',v_creator)
 );
 RETURN QUERY SELECT p_payroll_run_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_plan(p_tenant_id bigint, p_site_id bigint, p_source_type text, p_source_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 i public.invoices%ROWTYPE; pay public.payments%ROWTYPE;
 exp public.expenses%ROWTYPE; stock public.inventory_stock_movements%ROWTYPE;
 supplier public.supplier_ledger_entries%ROWTYPE;
 payroll public.payroll_runs%ROWTYPE;
 a public.account_transactions%ROWTYPE;
 ca public.company_accounts%ROWTYPE;
 purch public.supplier_purchases%ROWTYPE;
 sp public.supplier_payments%ROWTYPE;
 original public.inventory_stock_movements%ROWTYPE;
 v_count bigint;v_sum numeric;v_gross numeric;v_net numeric;v_adv numeric;v_other numeric;
 v_payload jsonb;v_lines jsonb:='[]'::jsonb;v_policy text;v_period text;
 v_reversal_id bigint;v_cash_account text;v_amount numeric;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
   OR p_source_id IS NULL OR p_source_id<=0 OR p_source_type IS NULL
   OR p_source_type NOT IN('invoice','payment','expense','stock_movement','supplier_ledger','payroll','payroll_payment')
   OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
      AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_SOURCE_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 IF p_source_type='invoice' THEN
  SELECT * INTO i FROM public.invoices
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR i.status NOT IN ('issued','overdue','partially_paid','paid')
     OR i.total_amount<=0 OR i.tax_amount<0 OR i.tax_amount>i.total_amount
     OR i.total_amount<>round(i.total_amount,2) OR i.tax_amount<>round(i.tax_amount,2)
     OR i.credit_applied_amount<>0 OR i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL
     OR i.cycle_end_at<i.cycle_start_at
  THEN RAISE EXCEPTION 'GL_INVOICE_UNVERIFIED_OR_CREDIT_NOT_SUPPORTED' USING ERRCODE='22023'; END IF;
  v_period:=to_char(i.issue_date AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
    jsonb_build_object('code','1200','side','debit','amount',i.total_amount),
    jsonb_build_object('code','2200','side','credit','amount',i.total_amount-i.tax_amount));
  IF i.tax_amount>0 THEN
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('code','2500','side','credit','amount',i.tax_amount));
  END IF;
  v_payload:=jsonb_build_object('id',i.id,'issuedAt',i.issue_date,
    'cycleStart',i.cycle_start_at,'cycleEnd',i.cycle_end_at,
    'gross',i.total_amount,'tax',i.tax_amount,'creditApplied',i.credit_applied_amount,
    'invoiceNo',i.invoice_no,'subscriberId',i.subscriber_id);
  v_policy:='invoice-receivable-v1-defer-service';
 ELSIF p_source_type='payment' THEN
  SELECT * INTO pay FROM public.payments WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR pay.status<>'completed' OR pay.amount<=0
    OR pay.amount<>round(pay.amount,2)
    OR pay.invoice_applied_amount<0 OR pay.subscriber_credit_amount<0
    OR pay.amount<>pay.invoice_applied_amount+pay.subscriber_credit_amount
    OR (pay.invoice_applied_amount>0 AND (pay.invoice_id IS NULL OR
      NOT EXISTS(SELECT 1 FROM public.invoices iv WHERE iv.id=pay.invoice_id
       AND iv.tenant_id=p_tenant_id AND iv.site_id=p_site_id)))
  THEN RAISE EXCEPTION 'GL_PAYMENT_AMOUNT_OR_INVOICE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=pay.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYMENT_COLLECTION_LINK_MISSING' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=pay.id FOR SHARE;
  IF a.site_id IS DISTINCT FROM p_site_id OR a.transaction_type<>'collection'
    OR a.amount<>pay.amount OR a.amount<=0
  THEN RAISE EXCEPTION 'GL_PAYMENT_COLLECTION_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
   WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_PAYMENT_CASH_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  -- A payment settles an already issued invoice. It must not create revenue twice.
  IF pay.invoice_applied_amount>0 AND NOT EXISTS(
    SELECT 1 FROM public.financial_gl_entries e WHERE e.tenant_id=p_tenant_id
     AND e.site_id=p_site_id AND e.source_type='invoice'
     AND e.source_id=pay.invoice_id::text AND e.source_revision=1)
  THEN RAISE EXCEPTION 'GL_PAYMENT_INVOICE_NOT_POSTED' USING ERRCODE='22023'; END IF;
  v_period:=to_char(pay.paid_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(jsonb_build_object('code',v_cash_account,'side','debit','amount',pay.amount));
  IF pay.invoice_applied_amount>0 THEN
   v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','1200','side','credit','amount',pay.invoice_applied_amount));
  END IF;
  IF pay.subscriber_credit_amount>0 THEN
   v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','2250','side','credit','amount',pay.subscriber_credit_amount));
  END IF;
  v_payload:=jsonb_build_object('id',pay.id,'paidAt',pay.paid_at,'amount',pay.amount,
   'invoiceId',pay.invoice_id,'applied',pay.invoice_applied_amount,
   'credit',pay.subscriber_credit_amount,'movementId',a.id,'accountId',a.account_id,
   'accountType',ca.account_type,'movementAmount',a.amount);
  v_policy:='payment-receivable-and-prepayment-v1';
 ELSIF p_source_type='expense' THEN
  SELECT * INTO exp FROM public.expenses WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR exp.amount<=0 OR exp.amount<>round(exp.amount,2)
    OR exp.company_account_id IS NULL
    OR exp.expense_classification NOT IN ('operating','non_operating')
    OR exp.category='payroll'
  THEN RAISE EXCEPTION 'GL_EXPENSE_NOT_CASH_VERIFIED' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=exp.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_LINK_MISSING' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=exp.id FOR SHARE;
  IF a.site_id IS DISTINCT FROM p_site_id OR a.transaction_type<>'withdrawal'
     OR a.amount<>exp.amount OR a.account_id<>exp.company_account_id
  THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
    WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(exp.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
   jsonb_build_object('code',CASE WHEN exp.expense_classification='operating'
      THEN '5100' ELSE '6100' END,'side','debit','amount',exp.amount),
   jsonb_build_object('code',v_cash_account,'side','credit','amount',exp.amount));
  v_payload:=jsonb_build_object('id',exp.id,'amount',exp.amount,'occurredAt',exp.occurred_at,
    'classification',exp.expense_classification,'category',exp.category,
    'movementId',a.id,'accountId',a.account_id,'cashType',ca.account_type);
  v_policy:='cash-expense-no-double-count-v1';
 ELSIF p_source_type='stock_movement' THEN
  SELECT * INTO stock FROM public.inventory_stock_movements
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR stock.total_cost_amount<=0 OR stock.total_cost_amount<>round(stock.total_cost_amount,2)
    OR stock.quantity<=0 OR stock.quantity*stock.unit_cost<>stock.total_cost_amount
    OR NOT EXISTS(SELECT 1 FROM public.inventory_items it
      WHERE it.id=stock.item_id AND it.tenant_id=p_tenant_id
        AND it.accounting_treatment='expense_on_issue')
  THEN RAISE EXCEPTION 'GL_STOCK_QUANTITY_COST_OR_CLASS_INVALID' USING ERRCODE='22023'; END IF;
  v_period:=to_char(stock.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  -- A paired warehouse transfer is NEVER an operating expense.
  -- The associated adjustment_in is a location move, not an undo of usage.
  IF stock.operation_key LIKE 'trf:%:out' OR
     stock.operation_key LIKE 'trf:%:in' THEN
    RAISE EXCEPTION 'GL_INTERNAL_STOCK_TRANSFER_NOT_AN_EXPENSE'
      USING ERRCODE='22023'; END IF;
  IF stock.movement_type='issue' THEN
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','5100','side','debit','amount',stock.total_cost_amount),
      jsonb_build_object('code','1300','side','credit','amount',stock.total_cost_amount));
  ELSIF stock.movement_type='adjustment_in' THEN
    IF stock.reversal_of_movement_id IS NULL THEN
      RAISE EXCEPTION 'GL_STOCK_ADJUSTMENT_NEEDS_SOURCE_LINK' USING ERRCODE='22023'; END IF;
    SELECT * INTO original FROM public.inventory_stock_movements m
    WHERE m.id=stock.reversal_of_movement_id AND m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.movement_type='issue' FOR SHARE;
    IF NOT FOUND OR original.item_id<>stock.item_id OR original.quantity<>stock.quantity
      OR original.total_cost_amount<>stock.total_cost_amount THEN
      RAISE EXCEPTION 'GL_STOCK_REVERSAL_NOT_MATCHED' USING ERRCODE='22023'; END IF;
    SELECT id INTO v_reversal_id FROM public.financial_gl_entries e
      WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
        AND e.source_type='stock_movement' AND e.source_id=original.id::text
        AND e.source_revision=1;
    IF v_reversal_id IS NULL THEN
      RAISE EXCEPTION 'GL_STOCK_REVERSAL_ORIGINAL_NOT_POSTED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','1300','side','debit','amount',stock.total_cost_amount),
      jsonb_build_object('code','5100','side','credit','amount',stock.total_cost_amount));
  ELSE
    RAISE EXCEPTION 'GL_STOCK_EVENT_ACCOUNTED_VIA_SUPPLIER_LEDGER_OR_UNSUPPORTED'
      USING ERRCODE='22023';
  END IF;
  v_payload:=jsonb_build_object('id',stock.id,'itemId',stock.item_id,
    'type',stock.movement_type,'quantity',stock.quantity,'unitCost',stock.unit_cost,
    'cost',stock.total_cost_amount,'date',stock.occurred_at,
    'reversesMovement',stock.reversal_of_movement_id);
  v_policy:='inventory-expense-on-issue-v1';
 ELSIF p_source_type='supplier_ledger' THEN
  SELECT * INTO supplier FROM public.supplier_ledger_entries
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR supplier.entry_type NOT IN ('purchase','supplier_return','payment')
    OR supplier.debit_amount<0 OR supplier.credit_amount<0
    OR supplier.debit_amount<>round(supplier.debit_amount,2)
    OR supplier.credit_amount<>round(supplier.credit_amount,2)
  THEN RAISE EXCEPTION 'GL_SUPPLIER_EVENT_INVALID' USING ERRCODE='22023'; END IF;
  v_period:=to_char(supplier.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  IF supplier.entry_type='purchase' THEN
    SELECT * INTO purch FROM public.supplier_purchases
     WHERE id=supplier.purchase_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
      AND m.movement_type='purchase_receipt';
    IF NOT FOUND OR purch.id IS NULL OR purch.status<>'received'
       OR v_count<1 OR supplier.debit_amount<>0 OR supplier.credit_amount<=0
       OR v_sum<>supplier.credit_amount
       OR purch.total_amount<>supplier.credit_amount THEN
      RAISE EXCEPTION 'GL_SUPPLIER_PURCHASE_NOT_RECEIVED_OR_RECONCILED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','1300','side','debit','amount',v_sum),
      jsonb_build_object('code','2300','side','credit','amount',supplier.credit_amount));
  ELSIF supplier.entry_type='supplier_return' THEN
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
     AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
     AND m.movement_type='supplier_return'
     AND m.reference_no=supplier.reference_no;
    IF supplier.reference_no IS NULL
      OR supplier.supplier_return_id IS NULL OR supplier.debit_amount<=0
      OR supplier.credit_amount<>0 OR v_sum<>supplier.debit_amount OR v_count<1
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.source_type='supplier_ledger' AND e.source_id IN (
          SELECT s.id::text FROM public.supplier_ledger_entries s
          WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
            AND s.entry_type='purchase' AND s.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_RETURN_NOT_RECONCILED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',supplier.debit_amount),
      jsonb_build_object('code','1300','side','credit','amount',supplier.debit_amount));
  ELSE
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id=supplier.supplier_payment_id AND tenant_id=p_tenant_id
       AND site_id=p_site_id FOR SHARE;
    IF NOT FOUND OR sp.status<>'posted' OR sp.amount<=0
       OR sp.amount<>supplier.debit_amount OR supplier.credit_amount<>0
       OR sp.account_transaction_id IS NULL
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_NOT_POSTED' USING ERRCODE='22023'; END IF;
    SELECT * INTO a FROM public.account_transactions
      WHERE id=sp.account_transaction_id AND tenant_id=p_tenant_id FOR SHARE;
    IF NOT FOUND OR a.site_id IS DISTINCT FROM p_site_id
       OR a.related_supplier_payment_id<>sp.id
       OR a.transaction_type<>'withdrawal' OR a.amount<>sp.amount
       OR a.account_id<>sp.company_account_id
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_CASH_MISMATCH' USING ERRCODE='22023'; END IF;
    SELECT * INTO ca FROM public.company_accounts
      WHERE id=a.account_id AND tenant_id=p_tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
    v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',supplier.debit_amount),
      jsonb_build_object('code',v_cash_account,'side','credit','amount',supplier.debit_amount));
    -- Supplier purchase is recognized once from supplier_ledger, never
    -- a second expense from the matching bank movement or receipt.
    IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
         AND e.source_type='supplier_ledger' AND e.source_id IN
         (SELECT sl.id::text FROM public.supplier_ledger_entries sl
          WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
            AND sl.entry_type='purchase' AND sl.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_PURCHASE_NOT_POSTED' USING ERRCODE='22023'; END IF;
  END IF;
  v_payload:=jsonb_build_object('id',supplier.id,'type',supplier.entry_type,
    'date',supplier.occurred_at,'purchaseId',supplier.purchase_id,
    'returnId',supplier.supplier_return_id,'paymentId',supplier.supplier_payment_id,
    'debit',supplier.debit_amount,'credit',supplier.credit_amount,
    'accountTxId',a.id,'receiptAmount',CASE WHEN supplier.entry_type='payment' THEN NULL ELSE v_sum END);
  v_policy:='supplier-event-no-stock-duplication-v1';
 ELSIF p_source_type='payroll' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR
    (payroll.status<>'approved' AND NOT (
       payroll.status='paid' AND EXISTS(
         SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
           AND e.source_type='payroll' AND e.source_id=payroll.id::text
           AND e.source_revision=1)))
    OR payroll.approved_by_user_id IS NULL
    OR payroll.approved_by_user_id=payroll.created_by_user_id
    OR payroll.total_gross<=0 OR payroll.total_net<=0 OR payroll.total_deductions<0
    OR payroll.total_gross<>payroll.total_net+payroll.total_deductions
  THEN RAISE EXCEPTION 'GL_PAYROLL_DRAFT_OR_UNAPPROVED' USING ERRCODE='22023'; END IF;
  SELECT count(*),coalesce(sum(it.base_amount+it.extra_amount),0),
    coalesce(sum(it.net_amount),0),coalesce(sum(it.advance_deduction),0),
    coalesce(sum(it.other_deduction),0)
  INTO v_count,v_gross,v_net,v_adv,v_other FROM public.payroll_items it
  WHERE it.payroll_run_id=payroll.id;
  -- Payroll paid state needs a separately verified cash settlement. The
  -- accrual entry below must never misstate a paid run as unpaid liability.
  IF payroll.status='approved' AND
     (payroll.paid_at IS NOT NULL OR payroll.paid_from_account_id IS NOT NULL)
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYMENT_REQUIRES_CASH_RECONCILIATION'
    USING ERRCODE='22023'; END IF;
  IF v_count<1 OR v_gross<>payroll.total_gross OR v_net<>payroll.total_net
    OR v_adv+v_other<>payroll.total_deductions OR v_adv<0 OR v_other<0
    OR payroll.total_gross<>round(payroll.total_gross,2)
  THEN RAISE EXCEPTION 'GL_PAYROLL_ITEMS_RECONCILIATION_FAILED' USING ERRCODE='22023'; END IF;
  IF NOT public.powerhub_payroll_advance_allocations_valid(p_tenant_id,p_site_id,payroll.id,payroll.period) THEN
    RAISE EXCEPTION 'GL_PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID' USING ERRCODE='23514';
  END IF;
  v_period:=payroll.period;
  v_lines:=jsonb_build_array(
    jsonb_build_object('code','5200','side','debit','amount',v_gross),
    jsonb_build_object('code','2400','side','credit','amount',v_net));
  IF v_adv>0 THEN v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','1700','side','credit','amount',v_adv)); END IF;
  IF v_other>0 THEN v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','2450','side','credit','amount',v_other)); END IF;
  v_payload:=jsonb_build_object('id',payroll.id,'period',payroll.period,
    'gross',v_gross,'net',v_net,'advance',v_adv,'other',v_other,
    'approvedBy',payroll.approved_by_user_id,'itemCount',v_count);
  v_policy:='payroll-accrued-gross-advance-deductions-v1';
 ELSIF p_source_type='payroll_payment' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR payroll.status<>'paid'
     OR payroll.paid_at IS NULL OR payroll.paid_from_account_id IS NULL
     OR payroll.total_net<=0 OR payroll.total_net<>round(payroll.total_net,2)
     OR payroll.approved_by_user_id IS NULL
     OR payroll.created_by_user_id=payroll.approved_by_user_id
     OR NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
          AND e.source_type='payroll' AND e.source_id=payroll.id::text)
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_ACCRUAL_NOT_POSTED'
    USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.category='payroll' AND e.reference_no='PAYROLL-'||payroll.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_EXPENSE_MISSING'
    USING ERRCODE='22023'; END IF;
  SELECT * INTO exp FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.category='payroll' AND e.reference_no='PAYROLL-'||payroll.id
    FOR SHARE;
  IF exp.amount<>payroll.total_net OR exp.company_account_id<>payroll.paid_from_account_id
    THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_AMOUNT_MISMATCH'
      USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions tx
    WHERE tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
      AND tx.reference_no='PAYROLL-'||payroll.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISSING'
    USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions tx
    WHERE tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
      AND tx.reference_no='PAYROLL-'||payroll.id FOR SHARE;
  IF a.related_expense_id<>exp.id OR a.transaction_type<>'withdrawal'
     OR a.amount<>payroll.total_net OR a.account_id<>payroll.paid_from_account_id
     OR (a.occurred_at AT TIME ZONE 'Asia/Gaza')::date<>(payroll.paid_at AT TIME ZONE 'Asia/Gaza')::date
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISMATCH'
      USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
    WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_ACCOUNT_UNKNOWN'
      USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(payroll.paid_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
   jsonb_build_object('code','2400','side','debit','amount',payroll.total_net),
   jsonb_build_object('code',v_cash_account,'side','credit','amount',payroll.total_net));
  v_payload:=jsonb_build_object('payrollRunId',payroll.id,'paidAt',payroll.paid_at,
    'net',payroll.total_net,'approvedBy',payroll.approved_by_user_id,
    'expenseId',exp.id,'movementId',a.id,'cashAccount',a.account_id,
    'cashAccountType',ca.account_type);
  v_policy:='payroll-settlement-no-second-wage-expense-v1';
 END IF;
 IF v_lines IS NULL OR jsonb_typeof(v_lines)<>'array' OR jsonb_array_length(v_lines)<2
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) item
       WHERE (item->>'amount')::numeric<=0
          OR (item->>'amount')::numeric<>round((item->>'amount')::numeric,2))
    OR (SELECT sum(CASE WHEN item->>'side'='debit' THEN (item->>'amount')::numeric
                   ELSE -(item->>'amount')::numeric END)
        FROM jsonb_array_elements(v_lines) item)<>0
 THEN RAISE EXCEPTION 'GL_SOURCE_PLAN_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,
    'sourceType',p_source_type,'sourceId',p_source_id,'period',v_period,
    'policyVersion',v_policy,'lines',v_lines,'reversesEntryId',v_reversal_id,
    'sourceFingerprint',encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'),
    'accountingCertification','NOT_CERTIFIED');
END;
$function$
;
