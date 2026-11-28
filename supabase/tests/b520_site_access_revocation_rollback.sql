-- B5.20: PostgreSQL authorization revocation test on Staging only.
-- Uses an existing test membership but makes NO persistent modifications:
-- whole transaction is always ROLLBACKed. Does not log any user identifiers.
BEGIN;
SET LOCAL statement_timeout='12000ms';
DO $test$
DECLARE
  uid bigint; tid bigint; access jsonb;
BEGIN
  SELECT s.tenant_id INTO tid FROM public.sites s WHERE s.id=1;
  SELECT m.user_id INTO uid FROM public.tenant_members m
  WHERE m.tenant_id=tid AND m.is_active AND m.membership_status='active'
    AND (m.expires_at IS NULL OR m.expires_at>now())
  ORDER BY m.id DESC LIMIT 1;
  IF uid IS NULL THEN RAISE EXCEPTION 'B520_NO_ACTIVE_MEMBER';END IF;

  access:=public.powerhub_site_access_snapshot(uid,1);
  IF access->'membership' IS NULL OR access->'membership'='null'::jsonb
    THEN RAISE EXCEPTION 'B520_ACTIVE_MEMBERSHIP_MISSING'; END IF;

  UPDATE public.tenant_members SET is_active=false
  WHERE tenant_id=tid AND user_id=uid AND is_active=true;
  access:=public.powerhub_site_access_snapshot(uid,1);
  IF access->'membership' IS NOT NULL AND access->'membership'<>'null'::jsonb
    THEN RAISE EXCEPTION 'B520_DISABLED_MEMBERSHIP_STILL_ACTIVE'; END IF;

  UPDATE public.users SET account_status='disabled' WHERE id=uid;
  access:=public.powerhub_site_access_snapshot(uid,1);
  IF access->'user'->>'account_status' IS DISTINCT FROM 'disabled'
    THEN RAISE EXCEPTION 'B520_DISABLED_ACCOUNT_NOT_VISIBLE'; END IF;

  IF has_function_privilege('anon','public.powerhub_site_access_snapshot(bigint,bigint)','EXECUTE')
    OR has_function_privilege('authenticated','public.powerhub_site_access_snapshot(bigint,bigint)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.powerhub_site_access_snapshot(bigint,bigint)','EXECUTE')
  THEN RAISE EXCEPTION 'B520_UNSAFE_EXECUTE_GRANT';END IF;
END $test$;
SELECT 'B520_REVOCATION_ROLLBACK_PASS' AS result;
ROLLBACK;
