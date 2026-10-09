-- Assign every newly inserted invoice to the canonical reading/billing cycle.
-- This covers direct web issuance and the mobile approval/issuance path without
-- maintaining two independent invoice-cycle implementations.

create or replace function public.powerhub_assign_invoice_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_reading_at timestamptz;
  v_cycle record;
begin
  if new.cycle_key is not null then return new; end if;

  if new.reading_id is not null then
    select reading_at into v_reading_at
    from public.meter_readings
    where id = new.reading_id
      and tenant_id = new.tenant_id;

    if v_reading_at is not null then
      select * into v_cycle
      from public.powerhub_cycle_for_reading(new.tenant_id, new.site_id, v_reading_at);

      new.cycle_key := v_cycle.cycle_key;
      new.cycle_start_at := v_cycle.cycle_start_at;
      new.cycle_end_at := v_cycle.cycle_end_at;

      -- Keep the existing YYYY-MM billing period contract for reports.
      if new.billing_period is null or new.billing_period = '' then
        new.billing_period := v_cycle.billing_period;
      end if;
    end if;
  end if;

  if new.cycle_key is null then
    select * into v_cycle
    from public.powerhub_cycle_for_reading(new.tenant_id, new.site_id, coalesce(new.issue_date, now()));

    new.cycle_key := v_cycle.cycle_key;
    new.cycle_start_at := v_cycle.cycle_start_at;
    new.cycle_end_at := v_cycle.cycle_end_at;
  end if;

  return new;
end;
$function$;

drop trigger if exists powerhub_assign_invoice_cycle_before_insert on public.invoices;
create trigger powerhub_assign_invoice_cycle_before_insert
before insert on public.invoices
for each row execute function public.powerhub_assign_invoice_cycle();

revoke execute on function public.powerhub_assign_invoice_cycle() from public, anon, authenticated;
grant execute on function public.powerhub_assign_invoice_cycle() to service_role;

-- Add the cycle identity to invoice notifications for audit/UI and future
-- cycle-level message operations. The invoice trigger still owns exact
-- subscriber/recipient/link identity.
create or replace function public.powerhub_enrich_invoice_notification_cycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_invoice public.invoices%rowtype;
begin
  if new.invoice_id is null then return new; end if;

  select * into v_invoice
  from public.invoices
  where id = new.invoice_id
    and tenant_id = new.tenant_id;

  if found then
    new.payload := jsonb_set(
      jsonb_set(
        coalesce(new.payload, '{}'::jsonb),
        '{cycleKey}',
        to_jsonb(v_invoice.cycle_key),
        true
      ),
      '{cycleStartAt}',
      to_jsonb(v_invoice.cycle_start_at),
      true
    );
    new.payload := jsonb_set(new.payload, '{cycleEndAt}', to_jsonb(v_invoice.cycle_end_at), true);
  end if;

  return new;
end;
$function$;

drop trigger if exists powerhub_enrich_invoice_notification_cycle_before_insert on public.notification_messages;
create trigger powerhub_enrich_invoice_notification_cycle_before_insert
before insert on public.notification_messages
for each row execute function public.powerhub_enrich_invoice_notification_cycle();

revoke execute on function public.powerhub_enrich_invoice_notification_cycle() from public, anon, authenticated;
grant execute on function public.powerhub_enrich_invoice_notification_cycle() to service_role;
