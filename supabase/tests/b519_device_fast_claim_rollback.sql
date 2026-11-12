-- B5.19 read-only request fast-path and exclusive-session regression.
-- All transient test device data is inserted in BEGIN and destroyed by ROLLBACK.
BEGIN;
SET LOCAL statement_timeout = '12000ms';
DO $check$
DECLARE
  u uuid; d uuid:=gen_random_uuid(); competitor uuid:=gen_random_uuid();
  l timestamptz:=now()+interval '48 hours'; allowed_result boolean;
  last_write timestamptz; new_write timestamptz;
  original_count bigint;
BEGIN
  SELECT id INTO u FROM auth.users au WHERE NOT EXISTS(
    SELECT 1 FROM public.powerhub_user_device_locks x WHERE x.user_id=au.id) LIMIT 1;
  IF u IS NULL THEN RAISE EXCEPTION 'NO_DISPOSABLE_USER';END IF;
  SELECT count(*) INTO original_count FROM public.powerhub_user_device_locks;
  INSERT INTO public.powerhub_user_device_locks(user_id,device_id,locked_until,last_seen_at,created_at,updated_at)
  VALUES(u,d,l,now(),now(),now());
  SELECT updated_at INTO last_write FROM public.powerhub_user_device_locks WHERE user_id=u;
  SELECT allowed INTO allowed_result FROM public.powerhub_claim_user_device(u,d,now()+interval '48 hours');
  SELECT updated_at INTO new_write FROM public.powerhub_user_device_locks WHERE user_id=u;
  IF allowed_result IS DISTINCT FROM true OR last_write IS DISTINCT FROM new_write
   THEN RAISE EXCEPTION 'FAST_CLAIM_CHANGED_ROW';END IF;
  SELECT allowed INTO allowed_result FROM public.powerhub_claim_user_device(u,competitor,now()+interval '48 hours');
  IF allowed_result IS DISTINCT FROM false THEN RAISE EXCEPTION 'COMPETING_DEVICE_ALLOWED';END IF;
  UPDATE public.powerhub_user_device_locks SET last_seen_at=now()-interval '31 seconds' WHERE user_id=u;
  SELECT allowed INTO allowed_result FROM public.powerhub_claim_user_device(u,d,now()+interval '48 hours');
  IF allowed_result IS DISTINCT FROM true THEN RAISE EXCEPTION 'RENEWAL_DENIED';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.powerhub_user_device_locks WHERE user_id=u AND last_seen_at>=now()-interval '3 seconds')
  THEN RAISE EXCEPTION 'RENEWAL_IGNORED';END IF;
  UPDATE public.powerhub_user_device_locks SET last_seen_at=now()-interval '16 minutes' WHERE user_id=u;
  SELECT allowed INTO allowed_result FROM public.powerhub_claim_user_device(u,competitor,now()+interval '48 hours');
  IF allowed_result IS DISTINCT FROM true THEN RAISE EXCEPTION 'STALE_HANDOFF_DENIED';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.powerhub_user_device_locks WHERE user_id=u AND device_id=competitor)
    THEN RAISE EXCEPTION 'STALE_HANDOFF_NOT_PERSISTED';END IF;
  IF (SELECT count(*) FROM public.powerhub_user_device_locks)<>original_count+1
    THEN RAISE EXCEPTION 'UNEXPECTED_DEVICE_ROWS'; END IF;
  IF has_function_privilege('anon','public.powerhub_claim_user_device(uuid,uuid,timestamp with time zone)','EXECUTE')
    OR has_function_privilege('authenticated','public.powerhub_claim_user_device(uuid,uuid,timestamp with time zone)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.powerhub_claim_user_device(uuid,uuid,timestamp with time zone)','EXECUTE')
  THEN RAISE EXCEPTION 'RPC_ACL_DRIFT'; END IF;
  RAISE NOTICE 'B519_FAST_CLAIM_GUARDS_PASS_ROLLBACK';
END
$check$;
SELECT 'B519_FAST_CLAIM_GUARDS_PASS_ROLLBACK' AS acceptance;
ROLLBACK;
