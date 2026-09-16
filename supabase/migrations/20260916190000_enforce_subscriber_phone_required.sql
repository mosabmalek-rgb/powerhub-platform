-- Subscriber contact contract:
-- phone is mandatory and WhatsApp remains optional.
-- Keep this invariant at the database boundary so direct/RPC writes cannot bypass it.

-- Fail closed if historical data ever contains a null/blank phone.
do $$
begin
  if exists (
    select 1
    from public.subscribers
    where phone is null or btrim(phone) = ''
  ) then
    raise exception 'SUBSCRIBER_PHONE_DATA_INVALID' using errcode = 'P0001';
  end if;
end;
$$;

alter table public.subscribers
  alter column phone set not null;

alter table public.subscribers
  drop constraint if exists subscribers_phone_required_check;

alter table public.subscribers
  add constraint subscribers_phone_required_check
  check (btrim(phone) <> '');

-- WhatsApp deliberately remains nullable/optional.
comment on column public.subscribers.phone is 'Required subscriber contact number.';
comment on column public.subscribers.whatsapp_number is 'Optional WhatsApp number; may be NULL.';
