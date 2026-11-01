
## تطبيق Migration صلاحيات المولدات على Staging — 2026-11-01

- بناءً على طلب المستخدم، طُبّق ملف `supabase/migrations/20261101113014_powerhub_generator_sync_require_tenant_membership.sql` عبر أداة Supabase على المشروع `powerhub-staging-dr` (`iyuryuhaylhisjfcrwkz`) فقط.
- أكدت أداة Supabase نجاح التطبيق، وسجل الترحيلات أصبح 311 مدخلاً، مع الإصدار والاسم المطابقين تمامًا: `20261101113014 / powerhub_generator_sync_require_tenant_membership`.
- فحص لاحق لتعريف الدالتين أكد بقاء التوقيعات كما هي، و`SECURITY DEFINER` مع `search_path=public, pg_temp`، وامتيازات التنفيذ: `anon=false`, `authenticated=true`, `service_role=true`. لم تتغير ACLs المقصودة.
- تعريف الدالتين الفعلي لا يحتوي اختصار تحويل `users.role='admin'` إلى مالك مستأجر؛ ويشترط عضوية مالك فعالة وغير منتهية في المستأجر المحدد أو ملف موظف نشطًا ومطابقًا لنطاق الموقع والصلاحية.
- جرى التحقق من أن Production لا يحتوي الإصدار `20261101113014`، ولم يُجرَ عليه أي تغيير. لم تحدث عمليات كتابة لمولدات أو مخزون أو حسابات.
- وُحّد اسم ملف المستودع مع الإصدار المسجل في Staging، وحُدّث مرجع `\\ir` في اختبار PostgreSQL. حُذف اسم الملف المبدئي `20261101111000` من الفرع لتجنّب ترحيل ثانٍ بنفس SQL عند إصدار لاحق.
- قبول المتصفح لا يزال غير منفذ. لا تنشأ Preview قبل إثبات أن `SUPABASE_SERVICE_ROLE_KEY` الخاص بالفرع يعود إلى Staging؛ المتغيرات الثلاثة الأخرى مؤكدة فقط.
- PR #359 يظل مفتوحًا وDraft وغير مدمج؛ يجب إعادة تشغيل CI على رأس الفرع بعد تعديل اسم الملف ومرجع الاختبار.
## Latest verified gate — 2026-11-01 (current authoritative state)

- PR #359 code head: `e17eaf778c8f821c1e48871fee597a478d6f2cb0`; open, Draft, unmerged.
- Four required workflows passed on this exact head: [PowerHub CI #5381](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/41302400432) (TypeScript, tests, production build), [PostgreSQL Integration #3029](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/41302400480), [Supabase Admin Guard #4862](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/41302400381), [PowerHub Security #5141](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/41302400455). CodeQL and Dependency Review were skipped; Dependency Audit passed.
- Staging migration `20261101113014 / powerhub_generator_sync_require_tenant_membership` was applied successfully. Staging ledger: 311 entries. Production ledger: 486 entries and does not contain this migration.
- Post-apply inspection confirms both generator RPC signatures, SECURITY DEFINER, `search_path=public, pg_temp`, and ACL preserved (`anon=false`, `authenticated=true`, `service_role=true`). The implicit platform-admin-to-tenant-owner shortcut is absent.
- E2E account `powerhub.e2e.test@gmail.com` remains active as `admin/platform_admin` with active owner membership in tenant 1.
- Security Advisor: 61 informational RLS-enabled/no-policy findings, 8 authenticated-callable SECURITY DEFINER functions, and leaked-password protection disabled. All 8 inspected functions deny `anon`; six notification/chat helpers derive the current user and scope to that user, while the two generator functions are now tenant-membership bounded. Account-suspension enforcement on notification helpers remains a separate review item; no broad ACL/RLS/Auth changes were made.
- Vercel confirms `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_URL` are Staging. The branch-scoped sensitive `SUPABASE_SERVICE_ROLE_KEY` returns `decrypted=false` and no value through the API, so its project association cannot be independently confirmed. No Preview was created.
- No Production migration or write, no live inventory/financial/SMS/payroll operation, and no browser acceptance were performed.
- Remaining: independently confirm the Preview service-role secret belongs to Staging; then run one isolated Preview browser acceptance (login, auth.me, reload/reopen, multi-tab, offline/online, Delta, Outbox, refresh-storm). Keep PR Draft until these gates are completed and accepted.

## 1. Current evidence

- The PR source, disposable PostgreSQL migrations/assertions, TypeScript, Vitest, production build, Security and Supabase Admin Guard have passed together on a single reviewed head before this checklist was added. Re-run all four required workflows on the new final SHA after this documentation change.
- The PostgreSQL integration suite proves the SQL invariants in isolated databases. It does not prove that the migrations have been applied to a live Staging project or that the browser UI passes end-to-end acceptance.
- The read-only Staging audit found **34 PR migrations absent** from the Staging migration ledger. The ledger history differs between Production and Staging; raw ledger row counts or version-name matches are not a replay plan.
- No migration from this PR has been applied to Staging or Production. No Preview has been deployed, and no live stock, HR, payment, SMS, or financial mutation was used for validation.

## 2. Migration ordering and dependency groups

Apply only through the repository's **Supabase Versioned Migration Release** workflow: `.github/workflows/supabase-migration-release.yml`, dispatched from `main`, with `target=staging`, the exact one-file `migration_path`, and `source_pr_number=359`. It pins the open same-repository PR head, copies only that SQL file into the trusted `main` release workspace, applies the file and records the exact Git version/name in `supabase_migrations.schema_migrations` in one transaction, under a PostgreSQL advisory lock and protected Staging environment approval.

**Do not use Supabase MCP `apply_migration` or broad `supabase db push --linked` for this PR.** MCP `apply_migration` generates a server-time version that cannot match the repository timestamp; a broad CLI push risks applying unrelated missing historical migrations because the two environment ledgers diverge. The versioned release workflow intentionally applies exactly one selected file per run. It fails closed if the protected Staging environment, reviewer rule, main-only deployment policy, guard token, project reference, or connection URI validation is missing or incorrect.

Preserve chronological order within each dependency group. Re-check the live migration ledger before each dispatch: skip only when both version and name already match; stop on any collision or partial/mismatched record. Do not edit migration ledger rows manually.

### A. Domain Delta read models and source journals
1. `20261027110000_powerhub_delta_invoice_history.sql`
2. `20261027130000_powerhub_delta_payment_history.sql`
3. `20261027140000_powerhub_delta_expense_history.sql`
4. `20261027150000_powerhub_delta_company_account_history.sql`
5. `20261029000000_powerhub_delta_inventory_catalog.sql`
6. `20261029100000_powerhub_delta_inventory_stocktakes.sql`
7. `20261029110000_powerhub_delta_purchase_headers.sql`
8. `20261029120000_powerhub_delta_receipt_return_headers.sql`
9. `20261029130000_powerhub_delta_fuel_maintenance_read_models.sql`
10. `20261029140000_powerhub_delta_fuel_events_maintenance_orders_parts.sql`
11. `20261029150000_powerhub_hr_delta_sync.sql`
12. `20261029160000_powerhub_hr_offline_operation_idempotency.sql`
13. `20261029192000_powerhub_offline_expense_idempotency.sql`
14. `20261030100000_powerhub_supplier_ledger_revision.sql`
15. `20261030110000_powerhub_hr_financial_delta_sync.sql`

### B. RLS, trigger and browser write-boundary reconciliation
16. `20261030150000_powerhub_inventory_trigger_acl_hardening.sql`
17. `20261030180000_powerhub_inventory_delta_bounded_membership_reconcile.sql`
18. `20261030200000_powerhub_browser_direct_dml_acl_reconcile.sql`
19. `20261030210000_powerhub_canonical_tenant_rls_policy_reconcile.sql`
20. `20261030220000_powerhub_missing_idempotency_schema_reconcile.sql`
21. `20261030230000_powerhub_missing_production_triggers_reconcile.sql`
22. `20261030240000_powerhub_chat_rls_scope_reconcile.sql`
23. `20261030250000_powerhub_chat_support_conversation_scope_hardening.sql`

### C. Domain idempotency, payment documentation and RPC contract reconciliation
24. `20261031120000_powerhub_inventory_stocktake_count_idempotency.sql`
25. `20261031130000_powerhub_payment_documentation_admin_precedence_reconcile.sql`
26. `20261031131000_powerhub_payment_documentation_public_rpc_reconcile.sql`
27. `20261031132000_powerhub_offline_operation_type_contract_reconcile.sql`
28. `20261031140000_powerhub_package_and_chat_schema_reconcile.sql`
29. `20261031160000_powerhub_invitation_rpc_idempotency_reconcile.sql`
30. `20261031170000_powerhub_custom_permission_role_rpc_idempotency_reconcile.sql`

### D. Final invalidation and platform identity policies
31. `20261031200000_powerhub_adaptive_delta_realtime.sql`
32. `20261031210000_powerhub_platform_identity_rls_alignment.sql`
33. `20261031220000_powerhub_fuel_cycle_boundary_precision.sql`
34. `20261101090000_powerhub_payment_documentation_revision_invalidation.sql`

Before each individual workflow dispatch, verify its preflight dependencies on the actual Staging schema and confirm the PR head is still ahead of current `main` with no commits behind. The workflow also validates the PR and immutable SHA. If `main` moves or the PR becomes behind, update the PR branch, rerun all four CI gates on its new head, and retry only then. If an object or migration identity is already present under a different historical name/version, stop and reconcile it explicitly; do not mark a migration as applied merely to skip it.

## 3. Required read-only post-apply checks

After each approved Staging batch, inspect the live catalog and migration ledger before moving to the next batch:

- Confirm all required tables, columns, indexes, triggers, functions and RPC signatures exist, and that the applied migration record is unique and matches the intended source.
- Confirm `powerhub_sync_scope_state` has RLS enabled and remains inaccessible for direct browser SELECT/DML; cursor access remains server-owned.
- Confirm `anon` has no HR table access; `authenticated` has only the intended SELECT grants on minimized HR projections/tables; `service_role` retains the backend DML needed for server RPCs.
- Confirm browser roles have no direct INSERT/UPDATE/DELETE/TRUNCATE on protected financial, inventory, fuel, maintenance, payroll and HR tables; verify idempotency RPCs remain server-only.
- Confirm Realtime is private, the Delta receive policy grants only SELECT, no browser INSERT policy exists for Delta topics, and the project-level public-channel setting remains disabled.
- Confirm platform RLS helper definitions now match the server identity contract: active `role='admin'` plus the allowlisted platform role. The legacy `is_platform_user()` name is only an admin compatibility alias; Platform Support must use its explicit platform capability, not cross-tenant RLS bypass.
- Confirm payment-documentation public context/status/target RPC definitions and grants match the intended environment contract; preserve the admin-disable precedence and read-only pending-status path.
- Confirm tenant/site isolation, membership expiry, subscription expiry/read-only-retention, RLS policy commands, and service-role grants after every relevant batch.

Any unexpected column/type constraint, row conflict, duplicate migration, ACL mismatch, missing dependency, or policy drift is a stop condition. Resolve it with a narrowly scoped forward migration and a disposable PostgreSQL test before proceeding.

## 4. Staging browser acceptance — not yet run

Run only after the approved Staging migration sequence and post-apply checks are complete, using designated Staging test accounts and test tenants/sites:

1. Authenticate online, load a selected tenant/site, then refresh and reopen the application offline. Confirm the correct scoped cache is restored and no stale user/site projection leaks.
2. Queue approved offline HR, fuel and inventory draft operations; reload offline; verify Outbox dependencies and stable operation IDs survive. Reconnect and confirm idempotent replay, server acknowledgements, conflict reporting and no duplicate effects.
3. Verify the Adaptive Delta behavior: immediate invalidation after a private marker, 30-second visible safety polling, 60–120-second fallback after Realtime disconnect, pause while hidden/offline, and recovery after reconnect.
4. Verify site switch, tenant switch, sign-out/sign-in, expired membership/subscription, and explicit 401/403. Only the denied scope projection may be cleared; never wipe unrelated cache or Outbox.
5. Verify inventory purchases/receipts/returns/transfers/stocktakes, fuel entries, maintenance orders/parts, HR employee/attendance/payroll-draft/advance requests, and payment documentation. Pending local requests must never appear as final approvals, posted stock/financial movements, or completed account receipts without server confirmation.
6. Verify dashboard KPIs and reports refresh independently by their own revision scopes and remain within the permitted site/all-branches authorization.
7. Capture browser evidence, network requests, server authorization outcomes, and post-sync database assertions. Do not use live supplier payments, final payroll approval, SMS dispatch or production financial/stock operations.

## 5. Manual workflow execution and approval

For each of the 34 entries above, the release owner opens [Supabase Versioned Migration Release](https://github.com/mosabmalek-rgb/powerhub-platform/actions/workflows/supabase-migration-release.yml) on `main`, selects `target=staging`, pastes exactly one migration path, and sets `source_pr_number=359`. Each run must receive protected approval through the `supabase-staging` GitHub environment. The workflow must report the pinned PR head and exact migration version; verify the resulting version/name immediately using the Staging migration ledger before dispatching the next file. Never batch multiple SQL files into one input.

The workflow fails closed unless the Staging environment has a required human reviewer, allows only the `main` branch, and has the read-only environment-guard token and Staging-specific DB/project secrets configured by a repository administrator. These settings and secret values are never inferred from source code and must not be printed in logs.

## 6. Release boundaries

- Keep PR #359 Draft/open while Staging schema reconciliation and browser acceptance remain incomplete.
- Do not deploy a Preview until all requested tabs are implemented and the Staging browser gate is approved. A Preview is not a substitute for live Staging schema or browser acceptance.
- Production migration application requires a separate explicit release approval and its own preflight/post-apply verification. Do not replay the Staging batch into Production blindly.
- No Production DDL/DML, real SMS, final financial posting, stock mutation, merge or deployment is authorized by this checklist.

## Fuel-cycle boundary regression — 2026-10-31

- The PostgreSQL inventory/fuel integration test exposed a fixture-only mismatch: its simplified `powerhub_cycle_for_reading` ended the third 10-day cycle on October 30, while the production contract ends the October 21–31 cycle at the final microsecond of October 31. The affected fill was dated October 31 and was consequently omitted from the cycle report.
- The test fixture now uses the exact production cycle resolver from `20261011110000_powerhub_reading_cycle_anchor_modes.sql`, rather than a hand-maintained approximation.
- The original fuel report period wrapper advanced the inclusive cycle end by 1 millisecond. Since the cycle resolver ends at microsecond precision, this overlapped the following cycle by 999 microseconds. New forward migration `20261031220000_powerhub_fuel_cycle_boundary_precision.sql` changes the exclusive end to exactly +1 microsecond while preserving the existing function signature, owner, grants and SECURITY DEFINER behavior.
- PostgreSQL coverage now includes October 31 in a 31-day month, February 29 in a leap year, 15-day and weekly boundaries, inclusion of the final-day fuel fill, and exclusion of that fill from the next cycle.
- This new migration is part of the Staging release list and requires the same one-file versioned release workflow and approval. No live database has been changed by this fix.


## Payment Documentation Delta invalidation — 2026-11-01

- Payment-documentation review requests advance a dedicated `payment_documentation` revision-only scope in `powerhub_sync_scope_state`.
- The scope stores only an opaque cursor. No request rows, receipt references, amounts, subscriber data, or other sensitive fields are appended to `powerhub_sync_changes`.
- The existing central private Realtime broadcaster emits the version-1 invalidation marker for the affected site and tenant-all scope; the protected revision endpoint verifies the current site permission and feature entitlement before returning the cursor and topic.
- The review page uses the shared Adaptive Delta scheduler and refetches the authorized list only when the revision changes. Its former 15-second list poller is removed.
- Forward migration `20261101090000_powerhub_payment_documentation_revision_invalidation.sql` is entry 34 in the one-file Staging release sequence. It has not been applied to Staging or Production.



### Server-side Preview Supabase isolation guard — 2026-11-01

- The privileged server client now resolves its project from server-only `SUPABASE_URL` first. Local development can still fall back to `VITE_SUPABASE_URL`.
- When `VERCEL_ENV=preview`, both `SUPABASE_URL` and `VITE_SUPABASE_URL` are required explicitly. Their origins must match; missing or mismatched values fail closed instead of silently sending service-role requests to the browser-configured project.
- Added contract tests for the current unsafe case (Preview with Production `VITE_SUPABASE_URL` and no server URL), cross-project mismatch, matching Staging, local-development fallback, and malformed URLs. The optional Auth admin integration test now uses the same URL resolver.
- This code guard does **not** configure Vercel secrets and does not make the existing branch deployment safe by itself. Branch Preview variables must still be set by the project owner to Staging values, including the Staging service-role key. Do not deploy or run browser acceptance until those values are configured and verified. No Vercel environment variable or Supabase secret was changed by this commit.
- CI and PostgreSQL must pass again on the new commit SHA; browser acceptance remains open.

## Final-head verification and first-admin release gate — 2026-11-01 (supersedes older SHA/status notes)

- Verified PR #359 head: `18f4a53edac545a1e7c0ee68108ad27823da67a6`. PR remains open and Draft, not merged. The branch includes current `main` (`behind_by=0`).
- All four required GitHub workflows completed successfully on that exact SHA:
  - PowerHub CI — TypeScript, tests, production build.
  - PowerHub Supabase Admin Guard — runtime migration guards.
  - Reading Cycle PostgreSQL Integration — workflow job completed successfully.
  - PowerHub Security — dependency audit completed successfully.
  - CodeQL analysis and Dependency Review were skipped; do not describe them as passed.
- Staging migration ledger was re-read: 308 entries; latest is `20261101085211_powerhub_payment_documentation_owner_constraint_reconcile`. The 35 previously released PR migrations remain present with exact version/name pairs. The new migration `20261101101932_powerhub_staging_first_platform_admin_bootstrap` is not present.
- A live read-only Staging check confirms the exact approved account still has `role=user`, `platform_role=platform_admin`, `account_status=active`; its Auth identity remains email-confirmed and unbanned. `must_change_password=false`, and the bootstrap RPC does not yet exist. No role or password mutation has occurred.
- Production migration ledger remains at 486 entries; it has no `20261101...` entries. The specific approved Auth UUID/email is absent from Production. No Production DDL/DML was performed.
- The branch-to-main comparison is `ahead` with `behind_by=0`; the migration source is an added file relative to current `main`, satisfying the release workflow's source preflight at this SHA.
- **Next release action:** use [Supabase Versioned Migration Release](https://github.com/mosabmalek-rgb/powerhub-platform/actions/workflows/supabase-migration-release.yml) from `main` with `target=staging`, `migration_path=supabase/migrations/20261101101932_powerhub_staging_first_platform_admin_bootstrap.sql`, and `source_pr_number=359`; obtain the required human approval in the protected `supabase-staging` environment. Apply exactly this one migration. Do not bypass the release runner with direct SQL or a differently versioned migration.
- After release, verify the exact migration ledger row, function definition, and ACL (EXECUTE only for `service_role`). Invoke the RPC only through a Staging service-role client, then verify the exact account became `role=admin` while its Auth identity, tenant memberships, platform role, and password fields remain unchanged.
- **Password is a separate operation and remains pending.** Set it through Supabase Auth Admin `updateUserById` in a server-side/local Staging-only operation; generate a random temporary value, set both Auth metadata and `public.users.must_change_password=true`, record an accurate system-origin audit event, verify sign-in without persisting a session, and deliver the value once through protected local output. Never put the service-role key or password in Git, PR comments, chat, or CI logs.
- No Preview Deployment, Production migration, merge, real SMS, final payroll approval, or live financial/stock operation was initiated by this verification.


## Supabase bootstrap migration applied — 2026-11-01

- Per the user's explicit instruction, the one-file bootstrap migration was applied through the available Supabase migration tool to Staging project `iyuryuhaylhisjfcrwkz`; no other migration was applied in that operation.
- Supabase generated and recorded version `20261101101932` with name `powerhub_staging_first_platform_admin_bootstrap`. The live Staging ledger now has 309 records, with the exact version/name pair present. The repository migration file is therefore `supabase/migrations/20261101101932_powerhub_staging_first_platform_admin_bootstrap.sql`; its audit metadata and isolated test include the same version.
- The applied migration only defines `public.powerhub_staging_bootstrap_first_platform_admin()`. It does not invoke the function or alter the target user. Post-apply read-only verification confirmed the exact user still has `role=user`, `platform_role=platform_admin`, `account_status=active`, `must_change_password=false`, no temporary-password timestamp, and no bootstrap audit row.
- Live function ACL verification: `anon` and `authenticated` cannot execute; `service_role` can execute. The function is `SECURITY DEFINER` with pinned `search_path=public, auth, pg_temp`.
- Production remains unchanged: its ledger still has 486 entries and does not contain this migration.
- This direct Supabase-tool application was a one-off execution explicitly requested by the user, and the generated ledger version has been reconciled into source. Preserve the protected release workflow for subsequent migration operations unless the user changes that instruction.
- **Remaining action:** invoke the RPC under the `service_role` database role, then verify the single-account role promotion and audit row. Password issuance remains a separate Auth Admin API operation and has not occurred.

## First Staging platform-admin bootstrap invoked and verified — 2026-11-01

- Invoked `public.powerhub_staging_bootstrap_first_platform_admin()` on Staging project `iyuryuhaylhisjfcrwkz` using the Supabase SQL tool inside a transaction with `SET LOCAL ROLE service_role`. The RPC returned `bootstrapped`.
- Post-invocation read-only verification confirms the exact approved profile (application user id `259`, approved Auth UUID) is now `role=admin`, `platform_role=platform_admin`, `account_status=active`.
- Auth identity remains email-confirmed and unbanned. Password was not changed: `must_change_password=false`, `temporary_password_issued_at=NULL`.
- Exactly one matching bootstrap audit event exists, with `created_by_user_id=NULL`, `passwordChanged=false`, and `membershipsChanged=false`. No tenant membership rows for this application user were present in `public.tenant_members`; the bootstrap function itself contains no membership DML.
- Function ACL remains restricted: `anon=false`, `authenticated=false`, `service_role=true`. Replay safety is implemented through the function's idempotent `already_bootstrapped` branch and advisory transaction lock.
- Staging migration ledger: 309 rows, exact entry `20261101101932 / powerhub_staging_first_platform_admin_bootstrap`. Production remains 486 rows with no corresponding migration.
- Temporary password issuance and first successful sign-in are still outstanding. Do not claim the account is ready for browser login until a secure Auth Admin password update and sign-in verification have completed.
- CI for the source reconciliation commit was still running at the time this note was added; verify all four required workflows on the new final PR head before considering this documentation/source update fully gated.


## نقل صلاحية مدير المنصة إلى حساب E2E المعروف — 2026-11-01

- **موافقة المستخدم:** اعتمد المستخدم نقل الصلاحية من Support E2E Operator إلى powerhub.e2e.test@gmail.com، وليس إنشاء مدير ثانٍ.
- **ترحيل Staging:** سجل Supabase migration ledger الإصدار 20261101104729 / powerhub_staging_platform_admin_transfer_to_known_e2e_account. الترحيل عرّف إجراءً ثابت الهوية للحسابين، يتحقق من Auth المؤكد وغير المحظور، تطابق الاسم والبريد، الحالة والدورين السابقين، وجود مدير منصة نشط واحد، وعدم وجود عضويات مستأجر على حساب المصدر. ينفذ ترقية الهدف وتخفيض المصدر داخل المعاملة نفسها ويسجل حدثًا نظاميًا واحدًا.
- **النتيجة الحية التي تحققت منها بعد التنفيذ:** الحساب powerhub.e2e.test@gmail.com (public.users id 4) أصبح role=admin, platform_role=platform_admin, account_status=active. حساب Support (id 259) عاد إلى role=user, platform_role=NULL, وبقي نشطًا. عدد مديري المنصة النشطين يساوي واحدًا.
- **الحفاظ على البيانات:** عضوية المستأجر الواحدة للحساب الهدف بقيت كما هي؛ حساب Support لم تكن له عضويات مستأجر. لم تتغير كلمات المرور أو بيانات Auth أو أعلام تغيير كلمة المرور. سجل platform_security_events يحمل staging_platform_admin_transfer ويشير إلى الحسابين، مع created_by_user_id=NULL وعدم تغيير بيانات المصادقة أو كلمات المرور أو العضويات.
- **إغلاق الإجراء:** الترحيل يسحب EXECUTE من PUBLIC, anon, authenticated, وservice_role بعد التنفيذ. تحقق مستقل أكد أن الصلاحية لا تزال غير متاحة لأي من هذه الأدوار.
- **مصدر الكود والاختبار:** أضيف supabase/migrations/20261101104729_powerhub_staging_platform_admin_transfer_to_known_e2e_account.sql وsupabase/tests/staging_platform_admin_transfer.sql، وربط اختبار PostgreSQL في .github/workflows/reading-cycle-sql-integration.yml. الاختبار المعزول يتحقق من الدورين، عدد المديرين، عضوية المستأجر، عدم تغير password hashes وAuth identities، وسجل التدقيق وسحب الصلاحيات.
- **حدود القبول:** لا يعني نجاح النقل أن تسجيل الدخول بالحساب الجديد قد اختُبر. يلزم اختبار دخول حقيقي في بيئة Preview معزولة عن Production Supabase بعد التحقق من إعدادات البيئة الأربع (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). لا تُنشأ Preview قبل عزلها. لا Production migration أو merge أو نشر إنتاجي ضمن هذا الإجراء.
- **CI:** يجب أن تنجح البوابات الأربع على SHA واحد بعد إضافة الترحيل والاختبار وسطر workflow والتوثيق. CodeQL وDependency Review إذا كانا skipped لا يعدان نجاحًا.
