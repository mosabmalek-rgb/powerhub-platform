-- Extend subscriber categories without rewriting or replacing existing operational RPC bodies.
-- Keep the current function signatures, security modes, and grants intact.
alter table public.subscribers
  drop constraint if exists subscribers_subscription_type_check;

alter table public.subscribers
  add constraint subscribers_subscription_type_check
  check (subscription_type in ('residential', 'commercial', 'institution', 'mosque'));

do $patch_subscriber_type_validation$
declare
  v_record record;
  v_definition text;
  v_patched text;
  v_bulk_patched boolean := false;
  v_opening_patched boolean := false;
begin
  for v_record in
    select p.oid, p.proname, p.pronargs, pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        (p.proname = 'powerhub_bulk_upsert_subscribers' and p.pronargs = 8)
        or (p.proname = 'powerhub_create_subscriber_with_opening_reading' and p.pronargs = 15)
      )
  loop
    v_definition := v_record.definition;
    v_patched := v_definition;

    if v_record.proname = 'powerhub_bulk_upsert_subscribers' then
      v_patched := regexp_replace(
        v_patched,
        $pattern$st[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'residential'[[:space:]]*,[[:space:]]*'commercial'[[:space:]]*\)$pattern$,
        $replacement$st not in ('residential','commercial','institution','mosque')$replacement$,
        'gi'
      );
      if v_patched = v_definition then
        raise exception 'SUBSCRIBER_BULK_TYPE_VALIDATION_PATTERN_NOT_FOUND';
      end if;
      v_bulk_patched := true;
    elsif v_record.proname = 'powerhub_create_subscriber_with_opening_reading' then
      v_patched := regexp_replace(
        v_patched,
        $pattern$p_subscription_type[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'residential'[[:space:]]*,[[:space:]]*'commercial'[[:space:]]*\)$pattern$,
        $replacement$p_subscription_type not in ('residential','commercial','institution','mosque')$replacement$,
        'gi'
      );
      if v_patched = v_definition then
        raise exception 'SUBSCRIBER_OPENING_READING_TYPE_VALIDATION_PATTERN_NOT_FOUND';
      end if;
      v_opening_patched := true;
    end if;

    execute v_patched;
  end loop;

  if not v_bulk_patched or not v_opening_patched then
    raise exception 'SUBSCRIBER_TYPE_VALIDATION_FUNCTIONS_NOT_FOUND';
  end if;
end;
$patch_subscriber_type_validation$;
