# CB-A: durable cache pruning race and P0 notification review

Source HEAD `0708ef532c0db127f5a8e56bede3132976ccb7db`: all six gates PASS (CI 46150052268, Security 46150052163, Admin Guard 46150052193, PostgreSQL 46150052178, B5 46150052160, Docker Shadow 46150052226). Native job 140994506306 emitted all nine required markers including TOP_LEVEL_WINDOW_LOCK. Prior HEAD 0bab3dfc shadow cancelled, not a six-gate PASS.

## Cache race candidate
Pruning used a read snapshot and later unconditional key deletion. A refreshed record can be deleted between those transactions. Recheck the full record in the write transaction; preserve a changed record, remove unchanged expired records, and reuse the comparison in legacy hydration. Explicit user/revocation purges are unchanged. Native test queues a competing write after getAll success, checks both preservation and deletion, protected Outbox equality and reload hydration. New required marker PR359_NATIVE_PRUNE_REFRESH_RACE_PASS. CI not yet verified; no full cross-tab live query/snapshot acceptance claimed.

## Four additional P0 exact signatures (12 of 34 initial source reviews)
- powerhub_notification_list(integer)
- powerhub_notification_unread_count()
- powerhub_notification_mark_read(bigint)
- powerhub_notification_mark_all_read()

Historical SQL sources and Git blobs:
- supabase/migrations/20261020173000_powerhub_notification_read_rpcs.sql: bb31188d996e23201b0b36021cf3405881703635.
- supabase/migrations/20261020170000_powerhub_unified_notifications.sql: 414e605be5571638c59dd63ce4910c5d42b8b808.
- client/src/pages/NotificationsCenterPage.tsx: 46c34785a17fbe770f26bd713ff84d8b81d39227 (all four direct RPC names).
- client/src/components/NotificationCenter.tsx: 65c93fed43ebab2bb712cb49307d7189ba473511 (list/count/mark read).
- server/offline-collections-notifications.contract.test.ts: 7126812d5f0451d0a0e41b09779856b62f964e8e (source contract, not actual JWT isolation test).

Reviewed historical definitions derive recipient from auth.uid(), use empty search_path, constrain all rows by recipient user_id, reject missing mapped user with 42501, revoke PUBLIC/anon execution and grant authenticated; list clamps limit to 1..100; mark read includes exact notification id; mark-all only unread rows. Historical table enables RLS and revokes direct client access. Gap: mapping queries in these four historical definitions do not explicitly require active account status. Need current executable definition parity, account-status/revocation policy reconciliation, and actual JWT cross-user/no-side-effect test before approval. Not a confirmed live vulnerability. Do not edit historical migrations or change hosted grants based on source hints. No signed approval. 22 remaining client-exposed P0 identities need initial targeted review, all 296 still pending final signoff. Global lock order, full HTTP runtime acceptance and executable CB-B remain open.
