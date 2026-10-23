-- Match the production audit event contract after verifying existing staging rows.
do $$
begin
  if exists (select 1 from public.audit_logs where entity_id is null) then
    raise exception 'AUDIT_LOG_ENTITY_ID_NULL_ROWS_EXIST';
  end if;
end
$$;

alter table public.audit_logs
  alter column entity_id set not null;
