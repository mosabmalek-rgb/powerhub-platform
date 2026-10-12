-- Allow electronic payment source and receiving account to use different providers.
-- Cash remains restricted to a cash destination. Electronic transfers may be received
-- by any active, enabled destination account in the same tenant/site scope.
-- Keep the currently deployed function bodies and their security/grant metadata; only
-- replace the three exact type-match guards and fail closed if their definitions drift.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
  v_signature regprocedure;
begin
  v_signature := to_regprocedure('public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid)');
  if v_signature is null then raise exception 'PAYMENT_DOC_SOURCE_DESTINATION_FIX: powerhub_create_payment missing'; end if;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $old$if v_account.account_type<>p_payment_method then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;$old$;
  v_new := $new$if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash') then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;$new$;
  if position(v_old in v_definition)=0 then raise exception 'PAYMENT_DOC_SOURCE_DESTINATION_FIX: create_payment guard did not match current definition'; end if;
  execute replace(v_definition,v_old,v_new);

  v_signature := to_regprocedure('public.powerhub_submit_payment_documentation(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text,text,text,text,uuid)');
  if v_signature is null then raise exception 'PAYMENT_DOC_SOURCE_DESTINATION_FIX: powerhub_submit_payment_documentation missing'; end if;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $old$if v_account.account_type <> p_payment_method then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;$old$;
  v_new := $new$if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash') then raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode='P0001'; end if;$new$;
  if position(v_old in v_definition)=0 then raise exception 'PAYMENT_DOC_SOURCE_DESTINATION_FIX: internal submit guard did not match current definition'; end if;
  execute replace(v_definition,v_old,v_new);

  v_signature := to_regprocedure('public.powerhub_submit_public_payment_documentation(text,bigint,numeric,text,text,text,text,text,uuid)');
  if v_signature is null then raise exception 'PAYMENT_DOC_SOURCE_DESTINATION_FIX: powerhub_submit_public_payment_documentation missing'; end if;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $old$if v_account.account_type <> p_payment_method then
    raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode = 'P0001';
  end if;$old$;
  v_new := $new$if (p_payment_method='cash' and v_account.account_type<>'cash') or (p_payment_method<>'cash' and v_account.account_type='cash') then
    raise exception 'COMPANY_ACCOUNT_TYPE_MISMATCH' using errcode = 'P0001';
  end if;$new$;
  if position(v_old in v_definition)=0 then raise exception 'PAYMENT_DOC_SOURCE_DESTINATION_FIX: public submit guard did not match current definition'; end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;
