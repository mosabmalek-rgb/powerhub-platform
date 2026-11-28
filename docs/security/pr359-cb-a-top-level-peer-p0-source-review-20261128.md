# CB-A P0 targeted source review and native top-level window acceptance

Pinned source HEAD: `0bab3dfc5b24c66f0a1dcf787698bb72e783d66c`. CI 46149421040, native job 140992576381 succeeded with eight required markers including HYDRATION_LIVE_AND_IDENTITY_RACE. Four other workflow gates succeeded; disposable shadow was still running when inspected. No inherited PASS claimed for subsequent HEAD.

## P0 targeted review, archived privilege evidence
The 34 public SECURITY DEFINER functions with archived authenticated-only EXECUTE include 28 chat functions, four notification functions and two generator synchronization functions. These eight exact identities now have a targeted source review:

| Signature | Pinned evidence | Remaining |
| --- | --- | --- |
| powerhub_sync_generator_create(bigint,text,text,text,numeric,text,text) | Browser RPC caller, capability helper and existing PostgreSQL acceptance fixture | live definition parity; full runtime and lock graph |
| powerhub_sync_generator_update(bigint,bigint,text,numeric,numeric,numeric,text,timestamp with time zone,text) | Same evidence, includes scoped generator update and expected version | live definition parity; full runtime and lock graph |
| chat_support_admin_snapshot() | SupportCenterPage direct RPC; historical SQL calls private.chat_assert_support_admin | current body, effective ACL and actual capability denial |
| chat_support_admin_save_settings(integer,integer) | SupportCenterPage save dispatch; historical SQL checks capability | same |
| chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean) | Same source paths | same |
| chat_support_admin_upsert_quick_reply(text,text,text,text,boolean) | Same source paths | same |
| chat_support_admin_upsert_sla(text,numeric) | Same source paths | same |
| chat_support_admin_upsert_tag(text,text,text,boolean) | Same source paths | same |

Pinned blobs:
- client/src/lib/offline-generator-sync.ts: 6229ef3994a2e854f2eda2cadd3cfb39419dac52 (RPC calls).
- supabase/migrations/20261105211328_powerhub_generator_rpc_effective_capability_scope.sql: cb11924b7ec50d41da419a3c9bb5a1c004be57ee (auth.uid, membership, capability overrides, explicit search_path).
- supabase/migrations/20261106080000_powerhub_offline_generator_idempotency_scope_guard.sql: fe13e888fdc151b146b304b9f97633e7f4c4789b (later scope guard; must not select earlier definition as canonical).
- supabase/tests/offline_generator_membership_expiry.sql: bc2f29c7b12bb65f1ff34a095fc0f0afb42de686 (ACL, missing JWT, expired membership, platform-only role, inactive staff, capability overrides, cross-site replay; reads multiple migrations including later scope guard).
- client/src/pages/SupportCenterPage.tsx: bac21393535fdaec078b683654b78e9ac59079fc.
- supabase/migrations/20260922183000_powerhub_chat_helpdesk_admin_controls_v1.sql: 1765b66a3c85979ea4570a02f94163af7f86f344 (historical helper, empty search_path, authenticated grants; not a fresh catalog proof).

No signed approval or fresh effective ACL. No direct inference of runtime closure from lexical caller evidence. The remaining 26 public client-exposed P0 identities still require targeted review; 262 non-client P0 identities require indirect paths.

## Browser candidate
Retain the iframe test and add a separate window.open top-level context with its own scope, real Web Locks contention and durable checkpoint/entity verification after release/reload. The runner requires a ninth marker. This is a same-origin disposable window, not independent hosted authenticated tabs or full live-query/snapshot-repair acceptance. No hosted changes or repair activation.

## Lock path
Existing compound scope concurrency fixture was inspected: it characterizes opposing scope order, verifies victim atomicity and retries the entire transaction. This is not a proof of global production lock ordering. HTTP acceptance and direct/indirect writer graph remain open.
