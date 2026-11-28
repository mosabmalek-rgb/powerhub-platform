# CB-A: real cache-ahead checkpoint abort and fresh Staging P0 review

Pinned source HEAD `d0ce92efd552498ddd8372bfe20fc80a7b29d182`. Native job 140997292800 on run 46150963246 succeeded with all ten prior markers, including PRUNE_REFRESH_RACE. CI, security, admin guard, PostgreSQL and B5 passed; shadow 46150963121 running when inspected. No six-gate claim for this HEAD yet.

## Browser acceptance candidate
Extend the real QueryClient/native IndexedDB test: successful mandatory cache commit followed by injected native cursor request success/transaction abort, old durable cursor/repairVersion and entities, no Delta pull, unchanged protected stores, cache ahead with correct snapshot, same-version retry, successful checkpoint and reload hydration. Require marker PR359_NATIVE_CACHE_AHEAD_CHECKPOINT_ABORT_REPLAY_PASS. This tests replay safety, not atomicity across two databases or an actual browser process crash at the interruption boundary. No operational activation.

## Fresh read-only Staging catalog (2026-11-28)
Executed SELECT on pg_proc/pg_namespace with has_function_privilege for exact OIDs, proconfig and SHA256(pg_get_functiondef). No table data read or hosted mutation. Nineteen reviewed public signatures all SECURITY DEFINER, anon EXECUTE false, authenticated EXECUTE true, explicit empty search_path. Seven private chat helpers also confirmed neither client role can EXECUTE (including current-user helper). No runtime JWT or signed approval.

The four notification definitions CURRENTLY require account_status='active', contrary to historical source-only suspicion in the prior review. All four constrain rows to mapped user_id. No live missing-active-status claim.
Seven additional chat signatures inspected with current definitions and historical caller evidence (19/34 initial review):
- chat_mark_all_notifications_read()
- chat_mark_delivered(bigint)
- chat_mark_notification_read(bigint)
- chat_mark_read(bigint)
- chat_mark_read_up_to(bigint,bigint)
- chat_receipts_for_message(bigint)
- chat_unread_notification_count()

Historical sources: client/src/lib/chatReceipts.ts blob c9f33b42f2c5fa27118c02f3714cce3bb57a2cb1; client/src/pages/NotificationsCenterPage.tsx 46c34785a17fbe770f26bd713ff84d8b81d39227; supabase/migrations/20260929100000_harden_chat_browser_wrappers.sql 50c9eef9185cc8907eeea6e8337edab6afe3533c; 20260914161000_chat_mark_read_up_to_v1.sql 1514d698a74cf360fa600785ffcf68b802f687d4; 20261005160000_chat_receipts_for_message.sql 282291544fb65e4ad96fcca8fb713e49dbc40bad; 20261020173000_powerhub_notification_read_rpcs.sql bb31188d996e23201b0b36021cf3405881703635.
Current receipts listing uses active auth UID mapping and conversation/visibility/sender/recipient/capability checks, not historical auth.uid()::bigint. Current private current-user helper requires active account; mark-read and delivered use conversation access and internal visibility checks. Mark-notification-read and unread count also check conversation accessibility.

## New unresolved behavioral findings in current private implementation
private.chat_mark_read_up_to(bigint,bigint) selects only r.id IS NULL, excluding preexisting delivered-only receipts from its insert/upsert despite coalescing read_at in the conflict arm. Both single and bulk mark-read update last_read_message_id unconditionally; investigate monotonicity, timestamps with ties, and concurrent requests. Bulk return count is based on updated_at >= now()-1 second, not statement row count. Mark-all notifications only scopes by user; compare visibility semantics against mark-one and unread count. These are source-level findings, not executed failure demonstrations. Require disposable PostgreSQL tests and reviewed source lineage before any correction; no live DDL or approval.

## Exact current public definition SHA256
- `chat_mark_all_notifications_read()`: `16a77dd421a3eb1eaea6bf3ee11824826e4c16bac32c96596830d763a67f532a`
- `chat_mark_delivered(bigint)`: `57df4b5a9082c7a917ef7a27039f375971339f71b2c043aa613a9c744fb2c33b`
- `chat_mark_notification_read(bigint)`: `310f49dba312a73f365a1025fa4f9ed2fd06db49503d747f9981d8bb0e2c78d4`
- `chat_mark_read(bigint)`: `00ef0ef4384b85dc403225b6ea9a798b2327d6909f522fc72891ab367d83d739`
- `chat_mark_read_up_to(bigint,bigint)`: `fe6241f674ceac37d431222468a520a0e1cc639925cc87ba229d8757a8035b72`
- `chat_receipts_for_message(bigint)`: `7e3d7cb7116e7ca6a78778c06be3350d4483aa6ccb300dfee5e414bfd6086ab3`
- `chat_support_admin_save_settings(integer,integer)`: `a9df258e77b9911abe8a33d1fb5705129b7e677fbe608eea962009eb0d0f1802`
- `chat_support_admin_snapshot()`: `00606d6c8cf126c935dda03639b8d94f78a284cc05ed96dbe0ea58db4600f46b`
- `chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean)`: `6bbcdd85de0c394ffe19b203845b9b57789d567ccb0583db03eaad54631d5846`
- `chat_support_admin_upsert_quick_reply(text,text,text,text,boolean)`: `7e68435d81379f70b2bdb07f343187c6565b06c1d9adce7b30a275a0c0ab93eb`
- `chat_support_admin_upsert_sla(text,numeric)`: `b1b1f3979b065f5a3ea7090f9d061ebd0334d2dcc48ae553940276f7ac7dfc05`
- `chat_support_admin_upsert_tag(text,text,text,boolean)`: `a30f806781fb7ddd960a1b8fe42823a2f73711c46c0b2aa156ed9636c3f7ad79`
- `chat_unread_notification_count()`: `6a550e717089156c1612a66a3f938d9c78d3ee85c7016e876e8908f9a2cb3b04`
- `powerhub_notification_list(integer)`: `a0fac67c9dc2114535f162fa0832af50089caa7c74b02aa5fe07d01b454a2542`
- `powerhub_notification_mark_all_read()`: `01064f720e09e8ef89b7ab4e030949a778d175029f47136255f390942836fd7a`
- `powerhub_notification_mark_read(bigint)`: `714fd2139cbac9cbd748f3a2ae356283683330b13d5c60285631fa45ba5fc60e`
- `powerhub_notification_unread_count()`: `e6a708522c90bad6a45d9b677fc17c6e55b7213fad197770d84ad29b910058b2`
- `powerhub_sync_generator_create(bigint,text,text,text,numeric,text,text)`: `82aa627ae8ae37801da4a77cff0e038ac64bf9f4314aba90ca868a876074f660`
- `powerhub_sync_generator_update(bigint,bigint,text,numeric,numeric,numeric,text,timestamp with time zone,text)`: `7c72840cc6ed96fe721e6ddcdb2665aedeb7e4df8d06206914a1e4c89ce569b7`
