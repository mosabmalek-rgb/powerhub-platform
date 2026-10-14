-- Reconcile the global invoice allocator across staging/prod schema baselines.
-- Preserve the high-water mark so issued/deleted invoice numbers are never reused.
create table if not exists public.powerhub_invoice_sequences (
  invoice_year integer primary key,
  next_sequence bigint not null check (next_sequence > 0)
);

alter table public.powerhub_invoice_sequences
  alter column next_sequence type bigint using next_sequence::bigint;
alter table public.powerhub_invoice_sequences
  drop constraint if exists powerhub_invoice_sequences_next_sequence_check;
alter table public.powerhub_invoice_sequences
  add constraint powerhub_invoice_sequences_next_sequence_check check (next_sequence > 0);

alter table public.powerhub_invoice_sequences enable row level security;
revoke all on table public.powerhub_invoice_sequences from public, anon, authenticated;
grant select, insert, update on table public.powerhub_invoice_sequences to service_role;

-- Seed missing years from existing invoice numbers in both historical 4-digit
-- and current 8-digit formats. Existing higher allocator values always win.
insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
select parsed.invoice_year, greatest(max(parsed.sequence_no) + 1, 2)
from (
  select
    (regexp_match(i.invoice_no, '^INV-([0-9]{4})-([0-9]{4,8})$'))[1]::integer as invoice_year,
    (regexp_match(i.invoice_no, '^INV-([0-9]{4})-([0-9]{4,8})$'))[2]::bigint as sequence_no
  from public.invoices i
  where i.invoice_no ~ '^INV-[0-9]{4}-[0-9]{4,8}$'
) parsed
group by parsed.invoice_year
on conflict (invoice_year) do update
set next_sequence = greatest(public.powerhub_invoice_sequences.next_sequence, excluded.next_sequence);
