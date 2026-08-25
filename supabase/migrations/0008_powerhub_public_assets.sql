-- Public visual identity assets only. Operational attachments remain in powerhub-private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'powerhub-public',
  'powerhub-public',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
