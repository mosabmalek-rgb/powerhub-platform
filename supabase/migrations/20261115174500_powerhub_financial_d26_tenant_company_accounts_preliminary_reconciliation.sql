-- D26: tenant-level company-account operational reconciliation, explicitly PRELIMINARY.
-- No backfill, no GL adjustment, no opening-evidence attestation or final statements.
-- One account opening per tenant, branch-tagged cash movements and fail-closed
-- transfer/source anomalies. Server-side service_role only.
CREATE OR REPLACE FUNCTION public.powerhub_financial_company_accounts_tenant_reconciliation(
  p_tenant_id bigint, p_period text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fn$
DECLARE
  v_cutoff timestamptz;
  v_site_count bigint;
  v_account_count bigint;
  v_opening numeric:=0;
  v_total bigint:=0;
  v_signed_net numeric:=0;
  v_unlinked bigint:=0;
  v_unknown bigint:=0;
  v_invalid_amount bigint:=0;
  v_invalid_account bigint:=0;
  v_invalid_site bigint:=0;
  v_transfer_in_count bigint:=0;
  v_transfer_out_count bigint:=0;
  v_transfer_in_amount numeric:=0;
  v_transfer_out_amount numeric:=0;
  v_gl_entries bigint:=0;
  v_accounts jsonb:='[]'::jsonb;
  v_sites jsonb:='[]'::jsonb;
  v_blockers jsonb:='[]'::jsonb;
  v_status text;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_period IS NULL
    OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS(SELECT 1 FROM public.sites
      WHERE tenant_id=p_tenant_id AND status='active')
  THEN RAISE EXCEPTION 'GL_D26_INVALID_TENANT_OR_PERIOD'
    USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_site_count FROM public.sites
    WHERE tenant_id=p_tenant_id AND status='active';
  IF v_site_count>30 THEN RAISE EXCEPTION 'GL_D26_TOO_MANY_SITES'
    USING ERRCODE='54000'; END IF;
  SELECT count(*),coalesce(sum(opening_balance),0)
  INTO v_account_count,v_opening
  FROM public.company_accounts WHERE tenant_id=p_tenant_id;
  IF v_account_count>1000 THEN RAISE EXCEPTION 'GL_D26_TOO_MANY_ACCOUNTS'
    USING ERRCODE='54000'; END IF;
  v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp
    AT TIME ZONE 'Asia/Gaza');

  -- One tenant-scoped scan; do not join company_accounts to sites before
  -- summing opening balances. Any invalid reference is an explicit blocker.
  SELECT count(*),
    coalesce(sum(CASE
      WHEN t.transaction_type IN('collection','deposit','transfer_in') AND
           a.id IS NOT NULL AND s.id IS NOT NULL AND t.amount>0 THEN t.amount
      WHEN t.transaction_type IN('withdrawal','transfer_out') AND
           a.id IS NOT NULL AND s.id IS NOT NULL AND t.amount>0 THEN -t.amount
      ELSE 0 END),0),
    count(*) FILTER(WHERE t.related_payment_id IS NULL
      AND t.related_supplier_payment_id IS NULL AND t.related_supplier_return_id IS NULL
      AND t.related_expense_id IS NULL AND t.related_account_id IS NULL),
    count(*) FILTER(WHERE t.transaction_type NOT IN
      ('collection','deposit','withdrawal','transfer_in','transfer_out')),
    count(*) FILTER(WHERE t.amount<=0),
    count(*) FILTER(WHERE a.id IS NULL),
    count(*) FILTER(WHERE s.id IS NULL),
    count(*) FILTER(WHERE t.transaction_type='transfer_in'),
    count(*) FILTER(WHERE t.transaction_type='transfer_out'),
    coalesce(sum(t.amount) FILTER(WHERE t.transaction_type='transfer_in'),0),
    coalesce(sum(t.amount) FILTER(WHERE t.transaction_type='transfer_out'),0)
  INTO v_total,v_signed_net,v_unlinked,v_unknown,v_invalid_amount,
    v_invalid_account,v_invalid_site,
    v_transfer_in_count,v_transfer_out_count,
    v_transfer_in_amount,v_transfer_out_amount
  FROM public.account_transactions t
  LEFT JOIN public.company_accounts a
    ON a.id=t.account_id AND a.tenant_id=t.tenant_id
  LEFT JOIN public.sites s
    ON s.id=t.site_id AND s.tenant_id=t.tenant_id
  WHERE t.tenant_id=p_tenant_id AND t.occurred_at<v_cutoff;

  -- Per-account opening is included ONCE. This is an operational roll-forward,
  -- not evidence that opening funds were documented or posted to the GL.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'accountId',a.id,'accountType',a.account_type,
    'openingBalanceUnverified',a.opening_balance,
    'movementCount',coalesce(m.n,0),
    'signedMovementNet',coalesce(m.net,0),
    'operationalAsOfBalanceUnverified',a.opening_balance+coalesce(m.net,0))
    ORDER BY a.id),'[]'::jsonb)
  INTO v_accounts
  FROM public.company_accounts a
  LEFT JOIN (
    SELECT account_id,count(*) n,
      coalesce(sum(CASE
        WHEN transaction_type IN('collection','deposit','transfer_in') AND amount>0
          THEN amount
        WHEN transaction_type IN('withdrawal','transfer_out') AND amount>0
          THEN -amount ELSE 0 END),0) net
    FROM public.account_transactions
    WHERE tenant_id=p_tenant_id AND occurred_at<v_cutoff
    GROUP BY account_id
  ) m ON m.account_id=a.id
  WHERE a.tenant_id=p_tenant_id;

  -- No opening allocation to branches. Every movement has exactly one site.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'siteId',s.id,'movementCount',coalesce(m.n,0),
    'signedMovementNet',coalesce(m.net,0),
    'openingBalanceAllocated',false)
    ORDER BY s.id),'[]'::jsonb)
  INTO v_sites
  FROM public.sites s
  LEFT JOIN (
    SELECT site_id,count(*) n,
      coalesce(sum(CASE
        WHEN transaction_type IN('collection','deposit','transfer_in') AND amount>0
          THEN amount
        WHEN transaction_type IN('withdrawal','transfer_out') AND amount>0
          THEN -amount ELSE 0 END),0) net
    FROM public.account_transactions
    WHERE tenant_id=p_tenant_id AND occurred_at<v_cutoff
    GROUP BY site_id
  ) m ON m.site_id=s.id
  WHERE s.tenant_id=p_tenant_id;

  SELECT count(*) INTO v_gl_entries FROM public.financial_gl_entries
  WHERE tenant_id=p_tenant_id AND period<=p_period;

  IF v_account_count=0 THEN v_blockers:=v_blockers||'"NO_COMPANY_ACCOUNTS"'::jsonb;END IF;
  IF v_unlinked>0 THEN v_blockers:=v_blockers||'"MOVEMENTS_WITHOUT_SOURCE_LINK"'::jsonb;END IF;
  IF v_unknown>0 THEN v_blockers:=v_blockers||'"UNKNOWN_MOVEMENT_TYPE"'::jsonb;END IF;
  IF v_invalid_amount>0 THEN v_blockers:=v_blockers||'"NONPOSITIVE_MOVEMENT_AMOUNT"'::jsonb;END IF;
  IF v_invalid_account>0 THEN v_blockers:=v_blockers||'"ACCOUNT_OUT_OF_TENANT_SCOPE"'::jsonb;END IF;
  IF v_invalid_site>0 THEN v_blockers:=v_blockers||'"SITE_OUT_OF_TENANT_SCOPE"'::jsonb;END IF;
  IF v_transfer_in_count<>v_transfer_out_count
     OR v_transfer_in_amount<>v_transfer_out_amount THEN
    v_blockers:=v_blockers||'"TRANSFER_SIDES_UNBALANCED"'::jsonb;
  END IF;
  v_status:=CASE WHEN jsonb_array_length(v_blockers)>0
    THEN 'BLOCKED_OPERATIONAL_RECONCILIATION'
    ELSE 'PRELIMINARY_OPERATIONAL_RECONCILIATION' END;

  RETURN jsonb_build_object(
    'tenantId',p_tenant_id,'period',p_period,'asOfExclusive',v_cutoff,
    'scope','TENANT_GLOBAL_COMPANY_ACCOUNTS',
    'status',v_status,'blockers',v_blockers,
    'accountCount',v_account_count,'activeSiteCount',v_site_count,
    'openingBalanceCountedOnceUnverified',v_opening,
    'totalMovementCount',v_total,'signedMovementNet',v_signed_net,
    'operationalAsOfBalanceUnverified',v_opening+v_signed_net,
    'unlinkedSourceMovementCount',v_unlinked,'unknownMovementTypeCount',v_unknown,
    'nonpositiveAmountCount',v_invalid_amount,
    'invalidAccountReferenceCount',v_invalid_account,
    'invalidSiteReferenceCount',v_invalid_site,
    'transferInCount',v_transfer_in_count,'transferOutCount',v_transfer_out_count,
    'transferInAmount',v_transfer_in_amount,'transferOutAmount',v_transfer_out_amount,
    'transferAmountDifference',v_transfer_in_amount-v_transfer_out_amount,
    'transferCountDifference',v_transfer_in_count-v_transfer_out_count,
    'transferPairingIndependentlyVerified',false,
    'glEntryCountAsOf',v_gl_entries,
    'glAndOperationalCashIndependentlyReconciled',false,
    'sourceOpeningEvidenceApproved',false,
    'companyAccountsIncludedInGlRollup',false,
    'accounts',v_accounts,'sites',v_sites,
    'isConsolidatedFinancialStatements',false,
    'canBeCertifiedConsolidation',false,
    'accountingCertification','NOT_CERTIFIED');
END $fn$;

REVOKE ALL ON FUNCTION public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)
  TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)
  IS 'D26 preliminary company cash tenant roll-forward only. Do not post to GL or treat as independently reconciled or certified.';
