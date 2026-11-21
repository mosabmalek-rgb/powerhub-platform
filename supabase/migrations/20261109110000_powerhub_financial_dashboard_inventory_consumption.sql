-- Align financial dashboard expense KPIs with financial settlement inventory
-- consumption rules. Purchases and supplier settlements are CASH/LIABILITY
-- movements, never P&L expense until eligible stock is issued/consumed.
-- This is a read-only, tenant/site/time-scoped aggregate with no financial mutations.
CREATE OR REPLACE FUNCTION public.powerhub_report_inventory_consumption_costs(
  p_tenant_id bigint,
  p_site_ids bigint[],
  p_period_start timestamptz,
  p_period_end_exclusive timestamptz
)
RETURNS TABLE (site_id bigint, inventory_consumption_cost numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp
AS $function$
  WITH effective_movements AS (
    SELECT m.site_id,
      CASE
        WHEN i.category='fuel' AND m.movement_type='fuel_consumption' THEN 'fuel'
        WHEN i.category IN ('oil','filter','maintenance_supply') THEN 'maintenance'
        WHEN i.category='spare_part' THEN 'parts'
        ELSE NULL
      END AS expense_category,
      CASE WHEN m.movement_type='return_from_issue'
        THEN -m.total_cost_amount ELSE m.total_cost_amount END AS signed_cost
    FROM public.inventory_stock_movements m
    JOIN public.inventory_items i ON i.tenant_id=m.tenant_id AND i.id=m.item_id
    WHERE m.tenant_id=p_tenant_id
      AND m.site_id=ANY(p_site_ids)
      AND m.movement_type IN ('issue','fuel_consumption','return_from_issue')
      AND m.occurred_at >= p_period_start
      AND m.occurred_at < p_period_end_exclusive
      AND (m.movement_type='return_from_issue' OR NOT EXISTS (
        SELECT 1 FROM public.inventory_stock_movements reversal
        WHERE reversal.tenant_id=m.tenant_id AND reversal.site_id=m.site_id
          AND reversal.reversal_of_movement_id=m.id
      ))
      AND (m.movement_type<>'return_from_issue' OR EXISTS (
        SELECT 1 FROM public.inventory_stock_movements source
        WHERE source.tenant_id=m.tenant_id AND source.site_id=m.site_id
          AND source.id=m.source_issue_movement_id AND source.movement_type='issue'
          AND source.occurred_at<=m.occurred_at
          AND NOT EXISTS (
            SELECT 1 FROM public.inventory_stock_movements reversal
            WHERE reversal.tenant_id=source.tenant_id AND reversal.site_id=source.site_id
              AND reversal.reversal_of_movement_id=source.id
          )
      ))
  )
  SELECT m.site_id,COALESCE(SUM(m.signed_cost),0)::numeric AS inventory_consumption_cost
  FROM effective_movements m
  WHERE m.expense_category IS NOT NULL
  GROUP BY m.site_id
$function$;

REVOKE ALL ON FUNCTION public.powerhub_report_inventory_consumption_costs(
  bigint,bigint[],timestamptz,timestamptz
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_report_inventory_consumption_costs(
  bigint,bigint[],timestamptz,timestamptz
) TO service_role;
COMMENT ON FUNCTION public.powerhub_report_inventory_consumption_costs(
  bigint,bigint[],timestamptz,timestamptz
) IS 'Read-only inventory issue costs for financial dashboard; mirrors settlement expense categories/reversals. Excludes supplier cash payments and unconsumed purchases.';
NOTIFY pgrst,'reload schema';
