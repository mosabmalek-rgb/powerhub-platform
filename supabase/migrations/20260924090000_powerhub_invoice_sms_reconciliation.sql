-- PowerHub: reconcile legacy invoice SMS rows and lock down internal RPCs.
-- Pending invoice SMS created before scheduled_at existed must be immediately due.

update public.notification_messages
set scheduled_at = created_at,
    payload = jsonb_set(
      coalesce(payload, '{}'::jsonb),
      '{scheduledAt}',
      to_jsonb(created_at),
      true
    )
where channel = 'sms'
  and event_type = 'invoice_issued'
  and status = 'pending'
  and scheduled_at is null;

-- These functions are internal database/worker boundaries. Do not expose them
-- through PostgREST to public, anonymous, or authenticated callers.
revoke all on function public.powerhub_queue_invoice_sms_after_issue() from public, anon, authenticated;
grant execute on function public.powerhub_queue_invoice_sms_after_issue() to service_role;

revoke all on function public.powerhub_invoice_sms_next_schedule(timestamptz, text, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_invoice_sms_next_schedule(timestamptz, text, timestamptz) to service_role;

revoke all on function public.powerhub_reschedule_pending_invoice_sms(bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_reschedule_pending_invoice_sms(bigint, text, timestamptz) to service_role;

create index if not exists notification_messages_sms_due_idx_reconciled
  on public.notification_messages (channel, event_type, status, scheduled_at, created_at)
  where channel = 'sms' and event_type = 'invoice_issued' and status = 'pending';
