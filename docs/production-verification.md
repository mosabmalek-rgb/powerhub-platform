# Production Verification Log

## 2026-08-25 — Supabase/Vercel migration checkpoints

- Vercel production deployment `dpl_5vxSdoiKqURdzawAEnRuWJAbXZ7r` reached `READY` from commit `dc5ce3d`.
- The public PowerHub landing page loads successfully at the production alias.
- The unauthenticated Mobile API endpoint `/api/mobile/v1/auth/me` returns a structured `401` response, confirming that the field API remains guarded.
- The legacy route `/api/scheduled/process-notifications` now returns the explicit `scheduled_jobs_disabled` response in production, so no Heartbeat/Forge execution path remains active.
- The currently verified production slices use Supabase for client authentication configuration, private storage URLs, Mobile API sessions/readings/sync events, web JWT profile synchronization, and the initial platform-owner overview/snapshot queries.
- Remaining internal operational routers still require staged migration from the legacy MySQL/Drizzle query layer before the product can be considered ready for full production use.

## Vercel Cron replacement notes

The official [Vercel Cron Jobs documentation](https://vercel.com/docs/cron-jobs) specifies production `GET` invocations configured in `vercel.json`, with five-field UTC schedules. The [management documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs) recommends a `CRON_SECRET` environment variable; Vercel sends it through the `Authorization: Bearer` header. Cron work must be idempotent and protected from concurrent execution. The current free-tier constraint is one invocation per day, so PowerHub's higher-frequency SMS queue must remain disabled unless the deployed Vercel plan or a compliant external scheduling design can satisfy its required cadence.
