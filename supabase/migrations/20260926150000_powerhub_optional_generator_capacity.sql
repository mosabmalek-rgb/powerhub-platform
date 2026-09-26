-- Generator rated capacity is informational and must not block core operations.
alter table public.generators
  alter column rated_capacity_kw drop not null;

-- Keep the existing non-negative check while allowing NULL.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.generators'::regclass
      and conname = 'generators_rated_capacity_kw_check'
  ) then
    alter table public.generators drop constraint generators_rated_capacity_kw_check;
  end if;
  alter table public.generators
    add constraint generators_rated_capacity_kw_check
    check (rated_capacity_kw is null or rated_capacity_kw >= 0);
end $$;

comment on column public.generators.rated_capacity_kw is
  'Optional generator rated capacity in kW; core PowerHub workflows must not depend on this value.';
