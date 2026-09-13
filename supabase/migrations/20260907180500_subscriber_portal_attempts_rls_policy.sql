-- Close the Supabase RLS advisor finding for the server-side portal rate-limit telemetry table.
-- The table remains inaccessible to anon/authenticated clients; only service_role is
-- explicitly allowed by policy and table grants.

create policy "subscriber_portal_attempts_service_role_only"
  on public.subscriber_portal_attempts
  for all
  to service_role
  using (true)
  with check (true);

comment on policy "subscriber_portal_attempts_service_role_only"
  on public.subscriber_portal_attempts
  is 'Allows only service_role to manage server-side portal rate-limit telemetry; anon/authenticated retain no table privileges.';
