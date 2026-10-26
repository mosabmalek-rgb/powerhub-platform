-- Harden the SECURITY DEFINER lifecycle worker against search_path shadowing.
-- Every application object referenced by the worker is schema-qualified.
alter function public.powerhub_process_subscription_lifecycle()
  set search_path = '';

