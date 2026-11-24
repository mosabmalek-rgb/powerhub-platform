\set ON_ERROR_STOP on
-- This is committed by psql on completion; the next file is another connection.
DO $first$
DECLARE n integer;
BEGIN
 n:=public.pr359_synthetic_keyset_page(1,10,1,'fuel_events',64,false);
 IF n<>64 THEN RAISE EXCEPTION 'PR359_KEYSET_FIRST_PAGE_COUNT_%',n; END IF;
 IF (SELECT count(*) FROM public.pr359_synthetic_keyset_sink)<>64
 OR (SELECT cursor_id FROM public.pr359_synthetic_keyset_checkpoint
     WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events')<>64
 THEN RAISE EXCEPTION 'PR359_KEYSET_FIRST_PAGE_NOT_ATOMIC'; END IF;
END
$first$;
SELECT 'PR359_ISOLATED_KEYSET_FIRST_PAGE_COMMITTED_PASS';
