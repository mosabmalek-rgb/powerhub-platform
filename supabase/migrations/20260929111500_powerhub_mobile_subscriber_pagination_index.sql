-- PowerHub: deterministic keyset pagination for the field-reader subscriber feed.
create index if not exists subscribers_tenant_site_id_idx
  on public.subscribers (tenant_id, site_id, id)
  where service_status = 'active';
