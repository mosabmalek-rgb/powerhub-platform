-- Verify pg_net placement without changing the Supabase-managed extension.
--
-- Hosted Supabase owns pg_net as supabase_admin. Application migrations run as
-- postgres and must not attempt to reassign that ownership or change the
-- extension's managed ACLs. The pg_net worker is configured to connect as
-- postgres, so its built-in grants must remain intact.
--
-- Existing installations in public require an operator-managed relocation.
-- The Data API exposed-schema configuration is an independent access boundary.

do $$
declare
  v_extension_schema text;
begin
  select n.nspname
    into v_extension_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_net';

  if v_extension_schema is null then
    raise exception 'pg_net is not installed; enable it from Supabase Database > Extensions before continuing';
  elsif v_extension_schema <> 'extensions' then
    raise warning
      'pg_net remains in schema %. No relocation was attempted. Use the Supabase-managed Extensions workflow after reviewing the stored response history.',
      v_extension_schema;
  else
    raise notice 'pg_net placement is extensions';
  end if;
end
$$;
