-- D34: make already-posted, immutable service-recognition replay independent of
-- temporary Staging-only prelaunch bootstrap expiry. Keep new posting fail-closed.
-- Preserve the installed function definition, including later actor/ACL guards.
DO $migration$
DECLARE
 v_function regprocedure:=to_regprocedure(
  'public.powerhub_financial_gl_recognize_billed_service(bigint,bigint,bigint,text,bigint)');
 v_original text;v_patched text;v_guard text;
 v_start integer;v_end_relative integer;v_target text:=
  ' IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r';
BEGIN
 IF v_function IS NULL THEN
  RAISE EXCEPTION 'D34_SERVICE_RECOGNITION_RPC_MISSING';END IF;
 SELECT pg_get_functiondef(v_function) INTO v_original;
 IF v_original NOT LIKE '%public.powerhub_financial_gl_authorized_actor%'
 OR v_original NOT LIKE '%GL_SERVICE_REPLAY_MISMATCH%'
 OR v_original NOT LIKE '%GL_SERVICE_OPENING_REQUIRED%'
 THEN RAISE EXCEPTION 'D34_UNRECOGNIZED_INSTALLED_RECOGNITION_SOURCE';END IF;
 v_start:=strpos(v_original,
  ' IF NOT EXISTS (SELECT 1 FROM public.financial_gl_opening_batches b');
 IF v_start=0 OR strpos(v_original,v_target)=0 THEN
  RAISE EXCEPTION 'D34_OPENING_OR_PERIOD_GUARD_ANCHOR_MISSING';END IF;
 v_end_relative:=position(' END IF;' IN substring(v_original FROM v_start));
 IF v_end_relative=0 THEN RAISE EXCEPTION 'D34_OPENING_GUARD_TERMINATOR_MISSING';END IF;
 v_guard:=substring(v_original FROM v_start FOR v_end_relative+length(' END IF;')-1);
 IF strpos(v_guard,'GL_SERVICE_OPENING_REQUIRED')=0
 OR strpos(v_guard,'powerhub_financial_gl_prelaunch_tech_valid')=0
 OR strpos(v_original,' IF FOUND THEN')<=v_start
 OR strpos(v_original,v_target)<=strpos(v_original,' IF FOUND THEN')
 OR substring(v_original FROM v_start+length(v_guard) FOR 1)<>chr(10)
 THEN RAISE EXCEPTION 'D34_UNSAFE_SOURCE_GUARD_STRUCTURE';END IF;
 v_patched:=replace(v_original,v_guard||chr(10),'');
 IF length(v_original)-length(v_patched)<>length(v_guard)+1
 OR strpos(v_patched,v_target)=0
 THEN RAISE EXCEPTION 'D34_UNEXPECTED_GUARD_REPLACEMENT_COUNT';END IF;
 v_patched:=replace(v_patched,v_target,v_guard||chr(10)||v_target);
 IF strpos(v_patched,'GL_SERVICE_OPENING_REQUIRED')<=
     strpos(v_patched,' IF FOUND THEN')
 OR strpos(v_patched,'GL_SERVICE_OPENING_REQUIRED')>=
     strpos(v_patched,v_target)
 OR length(v_patched)<>length(v_original)
 THEN RAISE EXCEPTION 'D34_REPLAY_GUARD_ORDER_NOT_PROVEN';END IF;
 -- Only the guard ordering changes; new postings still require a valid opening,
 -- and replay still requires source fingerprint, exact lines and operation key.
 EXECUTE v_patched;
END
$migration$;

COMMENT ON FUNCTION public.powerhub_financial_gl_recognize_billed_service(
 bigint,bigint,bigint,text,bigint)
 IS 'D34: verify immutable existing service GL replay first; only new postings require active opening/prelaunch authorization. Source fingerprint and exact debit/credit legs remain checked.';
