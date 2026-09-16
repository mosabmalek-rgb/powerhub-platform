revoke execute on function public.powerhub_apply_trial_duration() from public, anon, authenticated;
revoke execute on function public.powerhub_apply_trial_duration_8_days() from public, anon, authenticated;
revoke execute on function public.powerhub_ensure_owner_main_site() from public, anon, authenticated;
revoke execute on function public.powerhub_subscriber_reference_immutable() from public, anon, authenticated;

grant execute on function public.powerhub_apply_trial_duration() to service_role;
grant execute on function public.powerhub_apply_trial_duration_8_days() to service_role;
grant execute on function public.powerhub_ensure_owner_main_site() to service_role;
grant execute on function public.powerhub_subscriber_reference_immutable() to service_role;
