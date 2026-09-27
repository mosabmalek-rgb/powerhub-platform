-- PowerHub P1: hot-path indexes for tenant/site-scoped history and queue reads.
-- Apply to staging first and use EXPLAIN (ANALYZE, BUFFERS) before Production.

create index if not exists invoices_tenant_site_issue_date_id_idx
  on public.invoices (tenant_id, site_id, issue_date desc, id desc);

create index if not exists payments_tenant_site_paid_at_id_idx
  on public.payments (tenant_id, site_id, paid_at desc, id desc);

create index if not exists meter_readings_tenant_reading_at_id_desc_idx
  on public.meter_readings (tenant_id, reading_at desc, id desc);

create index if not exists expenses_tenant_site_occurred_at_id_idx
  on public.expenses (tenant_id, site_id, occurred_at desc, id desc);

create index if not exists notification_messages_tenant_due_queue_idx
  on public.notification_messages (tenant_id, channel, event_type, status, scheduled_at, id)
  where channel = 'sms' and status in ('pending', 'processing', 'failed');
