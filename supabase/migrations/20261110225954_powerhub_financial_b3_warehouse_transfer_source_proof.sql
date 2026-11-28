-- B3.1 Staging-only: count warehouse-to-warehouse transfers from
-- independent source/destination inventory movement pairs without mistaking
-- them for inter-site GL eliminations. Preliminary financial status remains.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_tenant_rollup(p_tenant_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s record; r jsonb; i jsonb; b jsonb; members jsonb:='[]'::jsonb;
 n bigint:=0; entries bigint:=0; gaps bigint:=0;
 assets numeric:=0; liabs numeric:=0; equity numeric:=0; retained numeric:=0;
 revenue numeric:=0; cost numeric:=0; wages numeric:=0; depr numeric:=0;
 provisions numeric:=0; other_exp numeric:=0; nonop numeric:=0;
 profit numeric:=0; equation numeric:=0; transfer_candidates bigint:=0;
 warehouse_count bigint:=0; warehouse_mismatch bigint:=0; warehouse_value numeric:=0;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_period IS NULL
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'GL_B3_INVALID_SCOPE' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO n FROM public.sites WHERE tenant_id=p_tenant_id AND status='active';
 IF n=0 THEN RAISE EXCEPTION 'GL_B3_NO_SITES' USING ERRCODE='22023';END IF;
 IF n>30 THEN RAISE EXCEPTION 'GL_B3_TOO_MANY_SITES' USING ERRCODE='54000';END IF;
 FOR s IN SELECT id,name FROM public.sites
 WHERE tenant_id=p_tenant_id AND status='active' ORDER BY id LOOP
   r:=public.powerhub_financial_gl_site_statements(p_tenant_id,s.id,p_period);
   IF (r->>'tenantId')::bigint IS DISTINCT FROM p_tenant_id
   OR (r->>'siteId')::bigint IS DISTINCT FROM s.id
   OR r->>'period' IS DISTINCT FROM p_period
   OR r->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
   OR (r->>'isMathematicallyBalanced')::boolean IS DISTINCT FROM true
   OR (r->>'isFinalProfit')::boolean IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'GL_B3_SITE_SCOPE_INVALID' USING ERRCODE='23514';END IF;
   i:=r->'incomeStatement';b:=r->'balanceSheet';
   entries:=entries+(r->>'glEntryCount')::bigint;
   gaps:=gaps+coalesce((r->>'unreconciledSourceCount')::bigint,0);
   assets:=assets+(b->>'netAssets')::numeric;
   liabs:=liabs+(b->>'liabilities')::numeric;
   equity:=equity+(b->>'postedEquity')::numeric;
   retained:=retained+(b->>'unclosedAccumulatedResult')::numeric;
   revenue:=revenue+(i->>'serviceRevenue')::numeric;
   cost:=cost+(i->>'directServiceCost')::numeric;
   wages:=wages+(i->>'wages')::numeric;
   depr:=depr+(i->>'depreciation')::numeric;
   provisions:=provisions+(i->>'provisions')::numeric;
   other_exp:=other_exp+(i->>'otherOperatingExpenses')::numeric;
   nonop:=nonop+(i->>'nonOperatingExpenses')::numeric;
   profit:=profit+(i->>'provisionalNetResult')::numeric;
   members:=members||jsonb_build_array(jsonb_build_object('siteId',s.id,
      'name',s.name,'entryCount',r->'glEntryCount',
      'provisionalNetResult',i->'provisionalNetResult',
      'assets',b->'netAssets','liabilities',b->'liabilities',
      'equationDifference',b->'equationDifference'));
 END LOOP;
 equation:=assets-liabs-equity-retained;
 IF equation<>0 OR profit<>revenue-cost-wages-depr-provisions-other_exp-nonop
 THEN RAISE EXCEPTION 'GL_B3_AGGREGATE_UNBALANCED' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO transfer_candidates FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.period<=p_period
 AND (e.source_type ~* '(transfer|inter.?site|inter.?branch)'
 OR e.operation_key ~* '(transfer|inter.?site|inter.?branch)');
 SELECT count(*),coalesce(sum(tr.total_cost_amount),0),
   count(*) FILTER(WHERE src.id IS NULL OR dst.id IS NULL
      OR src.site_id IS DISTINCT FROM tr.site_id
      OR dst.site_id IS DISTINCT FROM tr.site_id
      OR src.item_id IS DISTINCT FROM tr.item_id
      OR dst.item_id IS DISTINCT FROM tr.item_id
      OR src.warehouse_id IS DISTINCT FROM tr.source_warehouse_id
      OR dst.warehouse_id IS DISTINCT FROM tr.destination_warehouse_id
      OR src.movement_type IS DISTINCT FROM 'issue'
      OR dst.movement_type IS DISTINCT FROM 'adjustment_in'
      OR tr.source_warehouse_id=tr.destination_warehouse_id
      OR src.quantity IS DISTINCT FROM tr.quantity
      OR dst.quantity IS DISTINCT FROM tr.quantity
      OR src.total_cost_amount IS DISTINCT FROM tr.total_cost_amount
      OR dst.total_cost_amount IS DISTINCT FROM tr.total_cost_amount)
 INTO warehouse_count,warehouse_value,warehouse_mismatch
 FROM public.inventory_stock_transfers tr
 LEFT JOIN public.inventory_stock_movements src
   ON src.tenant_id=tr.tenant_id AND src.id=tr.source_movement_id
 LEFT JOIN public.inventory_stock_movements dst
   ON dst.tenant_id=tr.tenant_id AND dst.id=tr.destination_movement_id
 WHERE tr.tenant_id=p_tenant_id
 AND tr.created_at<(((p_period||'-01')::date+interval '1 month') AT TIME ZONE 'Asia/Gaza');
 RETURN jsonb_build_object(
 'tenantId',p_tenant_id,'period',p_period,'siteCount',n,'glEntryCount',entries,
 'siteScope','ALL_ACTIVE_SITES','sites',members,
 'status','PRELIMINARY_MULTI_SITE_ROLLUP',
 'accountingCertification','NOT_CERTIFIED','isConsolidatedFinancialStatements',false,
 'isFinalProfit',false,'isFinalBalanceSheet',false,
 'sourceOfTruth','POSTED_SITE_GL_ONLY','companyAccountsIncluded',false,
 'centralCostAllocationStatus','NOT_INCLUDED',
 'sharedCompanyAccountDoubleCountAvoidedByOmission',true,
 'interSiteTransferCandidateCount',transfer_candidates,
 'intraSiteWarehouseTransferCount',warehouse_count,
 'intraSiteWarehouseTransferValue',warehouse_value,
 'intraSiteWarehouseTransferMismatchCount',warehouse_mismatch,
 'warehouseTransferClassification','INTRA_SITE_STOCK_TRANSFER_NOT_GL_ELIMINATION',
 'interSiteTransferEliminationStatus','NOT_INDEPENDENTLY_RECONCILED',
 'unreconciledSourceCount',gaps,
 'incomeStatement',jsonb_build_object('serviceRevenue',revenue,
 'directServiceCost',cost,'wages',wages,'depreciation',depr,
 'provisions',provisions,'otherOperatingExpenses',other_exp,
 'nonOperatingExpenses',nonop,'provisionalNetResultBeforeEliminations',profit,
 'isFinalProfit',false),
 'positionBeforeEliminations',jsonb_build_object('netAssets',assets,
 'liabilities',liabs,'postedEquity',equity,'unclosedAccumulatedResult',retained,
 'equationDifference',equation,'isFinalBalanceSheet',false),
 'readiness',jsonb_build_object('balancedSiteEntries',true,
 'interSiteTransfersReviewed',false,
 'warehouseTransfersPaired',warehouse_mismatch=0,
 'companyAccountsReconciled',false,
 'centralAllocationApplied',false,'taxesMapped',false,
 'canBeCertifiedConsolidation',false));
END;$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_tenant_rollup(bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_tenant_rollup(bigint,text) TO service_role;
