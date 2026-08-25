-- A private bucket keeps receipts, reading photos, and branding assets outside public URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'powerhub-private',
  'powerhub-private',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
