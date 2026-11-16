\set ON_ERROR_STOP on

DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $roles$;
CREATE TABLE public.subscribers(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 subscriber_no text NOT NULL,full_name text NOT NULL,phone text NOT NULL,
 address text,service_status text NOT NULL DEFAULT 'active',archived_at timestamptz,
 assigned_reader_user_id bigint
);
CREATE TABLE public.meter_readings(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,subscriber_id bigint NOT NULL,
 reading_value numeric NOT NULL,reading_at timestamptz NOT NULL,
 status text NOT NULL,is_opening_baseline boolean NOT NULL DEFAULT false
);
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.subscribers,public.meter_readings TO service_role;
\ir ../migrations/20261116231000_powerhub_mobile_subscriber_delta_journal.sql

DO $acl$
BEGIN
 IF has_function_privilege('anon','public.powerhub_mobile_delta_fence(bigint,bigint)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_mobile_delta_fence(bigint,bigint)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_mobile_delta_fence(bigint,bigint)','EXECUTE')
 OR has_function_privilege('anon','public.powerhub_mobile_subscriber_projection(bigint,bigint,bigint,boolean,bigint[],timestamptz,timestamptz)','EXECUTE')
 THEN RAISE EXCEPTION 'MOBILE_DELTA_ACL_FAILED'; END IF;
END $acl$;

SET ROLE service_role;
INSERT INTO public.subscribers(id,tenant_id,site_id,subscriber_no,full_name,phone,assigned_reader_user_id)
 VALUES(1001,10,101,'S-1','Test One','059',7),
       (2001,20,201,'S-2','Other Tenant','099',9);
DO $insert$
DECLARE n bigint;
BEGIN
 SELECT count(*) INTO n FROM public.mobile_subscriber_change_log;
 IF n<>2 THEN RAISE EXCEPTION 'MOBILE_INSERT_EVENTS_MISSING %',n; END IF;
END $insert$;
INSERT INTO public.meter_readings(id,tenant_id,subscriber_id,reading_value,reading_at,status)
 VALUES(5001,10,1001,120.50,'2026-11-16T12:00:00Z','approved');
UPDATE public.meter_readings SET reading_value=121.25 WHERE id=5001;
UPDATE public.subscribers SET assigned_reader_user_id=8 WHERE id=1001;
UPDATE public.subscribers SET site_id=102 WHERE id=1001;
DO $moves$
DECLARE
  n bigint; old_user_events bigint; new_user_events bigint;
  old_branch_leaves bigint; highest bigint; new_branch_events bigint;
BEGIN
 SELECT count(*) INTO n FROM public.mobile_subscriber_change_log WHERE tenant_id=10;
 IF n<>6 THEN RAISE EXCEPTION 'MOBILE_EVENTS_COUNT_%',n; END IF;
 SELECT count(*) INTO old_user_events FROM public.mobile_subscriber_change_log
   WHERE tenant_id=10 AND branch_id=101 AND (old_reader_user_id=7 OR new_reader_user_id=7);
 SELECT count(*) INTO new_user_events FROM public.mobile_subscriber_change_log
   WHERE tenant_id=10 AND branch_id=101 AND (old_reader_user_id=8 OR new_reader_user_id=8);
 SELECT count(*) INTO old_branch_leaves FROM public.mobile_subscriber_change_log
   WHERE tenant_id=10 AND branch_id=101 AND change_type='leave';
 SELECT count(*) INTO new_branch_events FROM public.mobile_subscriber_change_log
   WHERE tenant_id=10 AND branch_id=102 AND change_type='touch';
 IF old_user_events<4 OR new_user_events<2 OR old_branch_leaves<>1 OR new_branch_events<>1 THEN
    RAISE EXCEPTION 'MOBILE_MOVE_TOMBSTONE_FAILED old=% new=% leaves=% newBranch=%',
       old_user_events,new_user_events,old_branch_leaves,new_branch_events;
 END IF;
 SELECT highwater INTO highest FROM public.powerhub_mobile_delta_fence(10,101);
 IF highest<>(SELECT max(sequence_id) FROM public.mobile_subscriber_change_log WHERE tenant_id=10)
 THEN RAISE EXCEPTION 'MOBILE_FENCE_INCORRECT'; END IF;
END $moves$;

DO $projection$
DECLARE n bigint;
BEGIN
 SELECT count(*) INTO n FROM public.powerhub_mobile_subscriber_projection(
  10,102,8,true,ARRAY[1001]::bigint[],
  '2026-11-01T00:00:00Z','2026-12-01T00:00:00Z'
 );
 IF n<>1 THEN RAISE EXCEPTION 'MOBILE_PROJECTION_ALLOW_FAILED'; END IF;
 SELECT count(*) INTO n FROM public.powerhub_mobile_subscriber_projection(
  10,102,7,true,ARRAY[1001]::bigint[],
  '2026-11-01T00:00:00Z','2026-12-01T00:00:00Z'
 );
 IF n<>0 THEN RAISE EXCEPTION 'MOBILE_PROJECTION_READER_LEAK'; END IF;
 SELECT count(*) INTO n FROM public.powerhub_mobile_subscriber_projection(
  20,201,8,true,ARRAY[1001]::bigint[],
  '2026-11-01T00:00:00Z','2026-12-01T00:00:00Z'
 );
 IF n<>0 THEN RAISE EXCEPTION 'MOBILE_PROJECTION_CROSS_TENANT_LEAK'; END IF;
END $projection$;
DELETE FROM public.meter_readings WHERE id=5001;
DELETE FROM public.subscribers WHERE id=1001;
DO $deletes$
DECLARE n bigint;
BEGIN
 SELECT count(*) INTO n FROM public.mobile_subscriber_change_log
 WHERE tenant_id=10 AND branch_id=102 AND change_type='leave';
 IF n<>1 THEN RAISE EXCEPTION 'MOBILE_DELETE_TOMBSTONE_MISSING'; END IF;
END $deletes$;
RESET ROLE;
SELECT 'MOBILE_DELTA_JOURNAL_PROJECTION_SCOPE_TESTS_PASS' AS result;
