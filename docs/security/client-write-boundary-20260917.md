# Client write boundary — 2026-09-17

The canonical migration `supabase/migrations/20260917230000_harden_client_write_boundary.sql` revokes direct browser INSERT/UPDATE/DELETE/TRUNCATE access to tenant business tables and removes the self-update policy from `public.users`, whose row contains authority-bearing fields.

Generator synchronization remains available through its dedicated authenticated RPCs; direct table writes remain disabled.
