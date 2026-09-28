-- Public assets are not currently used as anonymous objects.
-- Keep the bucket private; server-side code should issue signed URLs when needed.
update storage.buckets
set public = false
where id = 'powerhub-public';
