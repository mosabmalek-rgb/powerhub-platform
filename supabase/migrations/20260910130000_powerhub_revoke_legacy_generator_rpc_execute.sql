-- P7.3 hardening: legacy generator RPCs accept internal tenant/user ids and are not
-- part of the browser sync contract. Keep them non-callable by authenticated clients.
-- Browser sync uses powerhub_sync_generator_create/update, which derive identity from auth.uid().

revoke execute on function public.powerhub_create_generator(bigint,bigint,bigint,text,text,text,numeric,text,text) from public, authenticated;
revoke execute on function public.powerhub_update_generator(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) from public, authenticated;
