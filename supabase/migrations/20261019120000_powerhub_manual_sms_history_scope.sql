-- Include free-number manual SMS rows in the same tenant/site-isolated message history.
-- The optimized history RPC is optional in production. The server has a table-based,
-- tenant/site-filtered fallback, so an environment without the RPC must not fail deploy.
-- Older notifications with a null site_id continue to derive their site from linked entities.
do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_patched text;
begin
  v_function_oid := to_regprocedure(
    'public.powerhub_unified_messaging_history(bigint,bigint,text,date,date,text,text,text,text,integer,integer)'
  );

  if v_function_oid is null then
    raise notice 'Optional powerhub_unified_messaging_history RPC is absent; keeping the server-side fallback.';
  elsif not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_messages'
      and column_name = 'site_id'
  ) then
    raise notice 'notification_messages.site_id is absent; skipping optional history RPC patch.';
  else
    select pg_get_functiondef(v_function_oid) into v_definition;

    -- Make the migration repeatable when the function already contains all direct-site guards.
    if position('m.site_id,' in v_definition) > 0
       and position('and (m.site_id is null or m.site_id = p_site_id)' in v_definition) > 0
       and position('m.site_id = p_site_id' in v_definition) > 0 then
      raise notice 'Unified message history already has direct-site scoping; nothing to patch.';
    else
      v_patched := replace(
        v_definition,
        E'      m.id,\n      m.tenant_id,\n      m.invoice_id,',
        E'      m.id,\n      m.tenant_id,\n      m.site_id,\n      m.invoice_id,'
      );
      v_patched := replace(
        v_patched,
        E'    where m.tenant_id = p_tenant_id\n      -- If linked entities disagree on site, exclude the message instead of leaking it across sites.',
        E'    where m.tenant_id = p_tenant_id\n      and (m.site_id is null or m.site_id = p_site_id)\n      -- If linked entities disagree on site, exclude the message instead of leaking it across sites.'
      );
      v_patched := replace(
        v_patched,
        E'        s.site_id = p_site_id\n        or i.site_id = p_site_id',
        E'        m.site_id = p_site_id\n        or s.site_id = p_site_id\n        or i.site_id = p_site_id'
      );

      if v_patched = v_definition
         or position('m.site_id,' in v_patched) = 0
         or position('and (m.site_id is null or m.site_id = p_site_id)' in v_patched) = 0
         or position('m.site_id = p_site_id' in v_patched) = 0 then
        raise exception 'UNIFIED_MESSAGE_HISTORY_DIRECT_SITE_SCOPE_PATCH_FAILED';
      end if;

      execute v_patched;
    end if;
  end if;
end;
$migration$;
