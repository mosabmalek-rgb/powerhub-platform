-- The trigger is invoked by the database on invoice inserts, never directly through PostgREST.
revoke all on function public.powerhub_apply_subscriber_credit_after_invoice_insert() from public,anon,authenticated;
