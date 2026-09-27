-- PowerHub P0: composite indexes for bounded, deterministic history pagination.
-- Keep the tenant/site predicate first, then the stable descending timestamp and id tie-breaker.

create index if not exists meter_readings_site_reading_at_id_desc_idx
  on public.meter_readings (site_id, reading_at desc, id desc);

create index if not exists invoices_site_issue_date_id_desc_idx
  on public.invoices (site_id, issue_date desc, id desc);

create index if not exists payments_site_paid_at_id_desc_idx
  on public.payments (site_id, paid_at desc, id desc);

create index if not exists expenses_site_occurred_at_id_desc_idx
  on public.expenses (site_id, occurred_at desc, id desc);
