BEGIN;
SET LOCAL statement_timeout='120000ms';

DO $test$
DECLARE deniedA boolean:=false;deniedB boolean:=false;
BEGIN
 UPDATE public.supplier_payments
 SET status='reversed', reversed_at=now(), reversed_by_user_id=3,
     reversal_reason='synthetic forced replay check B4.14.1'
 WHERE tenant_id=1 AND site_id=1 AND id=5;
 BEGIN
 PERFORM public.powerhub_inventory_reverse_supplier_payment_flexible(1,1,3,5,'B4.14.1 tampered replay must fail');
 EXCEPTION WHEN SQLSTATE '22023' THEN deniedA:=true;END;
 BEGIN
 PERFORM public.powerhub_inventory_reverse_supplier_payment(1,1,3,5,'B4.14.1 tampered replay must fail');
 EXCEPTION WHEN SQLSTATE '22023' THEN deniedB:=true;END;
 IF NOT deniedA OR NOT deniedB THEN RAISE EXCEPTION 'B4141_FALSE_REPLAY_SUCCESS';END IF;
END $test$;
SELECT 'B4141_TAMPERED_REPLAY_BLOCKED_PASS_ROLLBACK' result;
ROLLBACK;