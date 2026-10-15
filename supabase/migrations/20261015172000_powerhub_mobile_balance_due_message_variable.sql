-- Ensure the mobile/manual invoice message renders the outstanding balance token.
-- This is display-only. A newly issued invoice has no payment yet, so its balance due
-- equals the authoritative total returned by powerhub_issue_invoice_from_reading.
-- The patch is safe to re-run and tolerates pg_get_functiondef whitespace normalization.
do $migration$
declare
  v_definition text;
  v_patched text;
  v_match text[];
  v_anchor text;
  v_anchor_pos integer;
  v_replacement constant text := $replacement$v_rendered := replace(v_rendered, '{{balance_due}}', round(v_total_amount, 1)::text);$replacement$;
begin
  select pg_get_functiondef(
    'public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric)'::regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'MOBILE_READING_FUNCTION_NOT_FOUND';
  end if;

  -- If a balance_due replacement already exists, normalize that entire statement.
  v_match := regexp_match(
    v_definition,
    $pattern$(v_rendered\s*:=\s*replace\s*\(\s*v_rendered\s*,\s*'\{\{balance_due\}\}'\s*,[^;]*;)$pattern$,
    'i'
  );

  if v_match is not null then
    v_anchor := v_match[1];
    if v_anchor ~* $pattern$round\s*\(\s*v_total_amount\s*,\s*1\s*\)::text$pattern$ then
      raise notice 'Mobile invoice balance_due message token is already formatted.';
      return;
    end if;

    v_anchor_pos := strpos(v_definition, v_anchor);
    if v_anchor_pos = 0 then
      raise exception 'MOBILE_BALANCE_DUE_STATEMENT_ANCHOR_NOT_FOUND';
    end if;

    v_patched := overlay(v_definition placing v_replacement from v_anchor_pos for length(v_anchor));
  else
    -- Locate the total_amount replacement, not the template string, and insert directly
    -- after its statement. Matching by regex avoids reliance on indentation or spacing.
    v_match := regexp_match(
      v_definition,
      $pattern$(v_rendered\s*:=\s*replace\s*\(\s*v_rendered\s*,\s*'\{\{total_amount\}\}'\s*,[^;]*;)$pattern$,
      'i'
    );
    if v_match is null then
      raise exception 'MOBILE_TOTAL_AMOUNT_STATEMENT_ANCHOR_NOT_FOUND';
    end if;

    v_anchor := v_match[1];
    v_anchor_pos := strpos(v_definition, v_anchor);
    if v_anchor_pos = 0 then
      raise exception 'MOBILE_TOTAL_AMOUNT_STATEMENT_POSITION_NOT_FOUND';
    end if;

    v_patched := overlay(
      v_definition placing E'\n    ' || v_replacement || E'\n'
      from v_anchor_pos + length(v_anchor) for 0
    );
  end if;

  if v_patched !~* $pattern$v_rendered\s*:=\s*replace\s*\(\s*v_rendered\s*,\s*'\{\{balance_due\}\}'\s*,\s*round\s*\(\s*v_total_amount\s*,\s*1\s*\)::text\s*\)$pattern$ then
    raise exception 'MOBILE_BALANCE_DUE_FORMAT_PATCH_VALIDATION_FAILED';
  end if;

  execute v_patched;

  select pg_get_functiondef(
    'public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric)'::regprocedure
  ) into v_definition;

  if v_definition !~* $pattern$v_rendered\s*:=\s*replace\s*\(\s*v_rendered\s*,\s*'\{\{balance_due\}\}'\s*,\s*round\s*\(\s*v_total_amount\s*,\s*1\s*\)::text\s*\)$pattern$ then
    raise exception 'MOBILE_BALANCE_DUE_FORMAT_PATCH_POST_VALIDATION_FAILED';
  end if;
end;
$migration$;
