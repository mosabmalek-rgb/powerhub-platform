-- P5.5: indexes for dashboard hot paths.
-- Applied to the connected Supabase production project through the Supabase migration tool.

create index if not exists collector_sessions_site_opened_at_idx
  on public.collector_sessions (site_id, opened_at desc);

create index if not exists invoices_site_issue_date_idx
  on public.invoices (site_id, issue_date desc);

create index if not exists expenses_site_created_at_idx
  on public.expenses (site_id, created_at desc);

create index if not exists notification_messages_subscriber_status_idx
  on public.notification_messages (subscriber_id, status);
