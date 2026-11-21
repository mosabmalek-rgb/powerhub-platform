-- A46: read-only Staging acceptance and expiry check. No GL, approval, or production writes.
DO $qa$
DECLARE r jsonb;tech jsonb;expired_at timestamptz;active boolean;
BEGIN
 r:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
 tech:=r->'technicalAcceptance';
 SELECT expires_at INTO expired_at FROM public.financial_gl_prelaunch_technical_bootstrap
 WHERE tenant_id=1 AND site_id=1;
 active:=public.powerhub_financial_gl_prelaunch_tech_valid(1,1,'2026-11');
 IF tech->>'status'<>'PASS_PRELAUNCH_ENGINEERING_ONLY'
 OR (tech->>'technicalBootstrapActive')::boolean IS DISTINCT FROM active
 OR (tech->>'technicalBootstrapExpiresAt')::timestamptz IS DISTINCT FROM expired_at
 OR (tech->>'documentaryOpeningAvailable')::boolean IS DISTINCT FROM false
 OR (tech->>'newPostingRequiresDocumentaryOpening')::boolean IS DISTINCT FROM NOT active
 OR (tech->>'isFinalFinancialAcceptance')::boolean IS DISTINCT FROM false
 OR tech->>'accountingCertification'<>'NOT_CERTIFIED'
 OR r->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (r->>'unreconciledSourceCount')::bigint<>0
 THEN RAISE EXCEPTION 'A46_EXPIRY_OR_CERTIFICATION_CONTRACT_FAILED'; END IF;
END;$qa$;
SELECT 'PASS_READ_ONLY' status,
 public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->'technicalAcceptance' technical_acceptance;
