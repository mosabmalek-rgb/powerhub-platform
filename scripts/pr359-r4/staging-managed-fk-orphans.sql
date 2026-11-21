-- R4 Staging: check relational integrity after data import performed with
-- session_replication_role=replica. A VALIDATED FK flag alone is not proof
-- that COPY with disabled FK triggers did not import orphaned app rows.
-- Only aggregate counts (no user IDs or row contents) leave this transaction.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
 'constraint','powerhub_user_device_locks_user_id_fkey',
 'orphans',count(*)::bigint)::text
FROM public.powerhub_user_device_locks t
WHERE t.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id=t.user_id)
UNION ALL
SELECT jsonb_build_object(
 'constraint','staff_password_reset_intents_auth_user_id_fkey',
 'orphans',count(*)::bigint)::text
FROM public.staff_password_reset_intents t
WHERE t.auth_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id=t.auth_user_id)
UNION ALL
SELECT jsonb_build_object(
 'constraint','users_auth_user_id_fkey',
 'orphans',count(*)::bigint)::text
FROM public.users t
WHERE t.auth_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id=t.auth_user_id);
COMMIT;
