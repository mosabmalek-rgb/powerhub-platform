# Client write boundary — 2026-09-17

Production hardening closes direct browser table writes for tenant business state and removes the self-update policy from `public.users`, whose row contains authority-bearing fields. Generator synchronization remains available through its dedicated authenticated RPCs; direct table writes remain disabled.

The canonical SQL migration is `supabase/migrations/20260917230000_harden_client_write_boundary.sql`.
