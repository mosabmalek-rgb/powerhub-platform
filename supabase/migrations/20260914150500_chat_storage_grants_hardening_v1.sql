-- Storage ACL hardening for Smart Support Chat.
-- The browser may read authorized private objects but cannot mutate storage metadata/files.

revoke all privileges on table storage.objects from anon, authenticated;
grant select on table storage.objects to authenticated;
