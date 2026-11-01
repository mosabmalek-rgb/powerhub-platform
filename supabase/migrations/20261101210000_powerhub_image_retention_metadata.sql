-- Track deleted chat image attachments without deleting the conversation/message history.
alter table public.chat_message_attachments
  add column if not exists storage_deleted_at timestamptz null;

create index if not exists chat_message_attachments_storage_deleted_at_idx
  on public.chat_message_attachments(storage_deleted_at)
  where storage_deleted_at is not null;

-- Align the informational retention deadline with the 15-day Storage object policy.
-- The scheduled Storage API cleaner uses object created_at as the deletion authority.
update public.payment_documentation_requests
set receipt_image_retention_until = created_at + interval '15 days'
where receipt_image_key is not null
  and receipt_image_deleted_at is null;
