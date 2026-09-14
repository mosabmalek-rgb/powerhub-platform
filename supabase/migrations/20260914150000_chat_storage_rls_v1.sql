-- Smart Support Chat: private attachment read access.
-- Browser clients may read only attachment objects that are already authorized
-- by the chat attachment RLS boundary. Upload/update/delete remain server-side.

create policy "chat_storage_select_conversation_access"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'powerhub-private'
  and exists (
    select 1
    from public.chat_message_attachments cma
    where cma.tenant_id is not null
      and cma.storage_bucket = bucket_id
      and cma.storage_path = name
  )
);

revoke insert, update, delete on table storage.objects from anon, authenticated;
