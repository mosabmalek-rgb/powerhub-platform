-- Include free-number manual SMS rows in the same tenant/site-isolated message history.
-- Older notifications may have a null site_id; their site continues to be derived from linked entities.
do $migration$
declare
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'powerhub_unified_messaging_history' and p.pronargs = 11;

  if v_definition is null then
    raise exception 'UNIFIED_MESSAGE_HISTORY_FUNCTION_NOT_FOUND';
  end if;

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
     or position('m.site_id = p_site_id' in v_patched) = 0 then
    raise exception 'UNIFIED_MESSAGE_HISTORY_DIRECT_SITE_SCOPE_PATCH_FAILED';
  end if;

  execute v_patched;
end;
$migration$;
