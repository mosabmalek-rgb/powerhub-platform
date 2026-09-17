# Client write boundary — 2026-09-17

The canonical migrations `supabase/migrations/20260917230000_harden_client_write_boundary.sql` and `supabase/migrations/20260917231000_close_remaining_client_table_writes.sql` close direct browser INSERT/UPDATE/DELETE/TRUNCATE access across the reviewed public application/configuration tables and remove the self-update policy from `public.users`, whose row contains authority-bearing fields.

Business-state mutations remain centralized in server-side/RPC paths so tenant/site scope, actor binding, audit, idempotency, concurrency and business-rule checks are not bypassed. Generator synchronization remains available through its dedicated authenticated RPCs; direct table writes remain disabled.
