-- Expose payment purpose to the trusted server-side Delta filter without exposing it as a browser RPC.
CREATE OR REPLACE FUNCTION public.powerhub_delta_sync_project_payment(
 p_tenant_id bigint,p_site_id bigint,p_payment_id bigint
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
  'id',p.id,'tenant_id',p.tenant_id,'site_id',p.site_id,
  'payment',public.powerhub_delta_sync_project_row('payments',to_jsonb(p))
    || jsonb_build_object('payment_purpose',p.payment_purpose),
  'subscriber',public.powerhub_delta_sync_project_row('subscribers',to_jsonb(s)),
  'invoice_no',i.invoice_no
 )
 FROM public.payments p
 JOIN public.sites site_scope ON site_scope.id=p.site_id AND site_scope.tenant_id=p.tenant_id
 JOIN public.subscribers s ON s.id=p.subscriber_id AND s.tenant_id=p.tenant_id AND s.site_id=p.site_id
 LEFT JOIN public.invoices i ON i.id=p.invoice_id AND i.tenant_id=p.tenant_id AND i.site_id=p.site_id
 WHERE p.id=p_payment_id AND p.tenant_id=p_tenant_id AND p.site_id=p_site_id;
$$;
ALTER FUNCTION public.powerhub_delta_sync_project_payment(bigint,bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_delta_sync_project_payment(bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_delta_sync_project_payment(bigint,bigint,bigint) TO service_role;
