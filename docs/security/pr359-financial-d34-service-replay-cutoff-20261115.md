# D34 — service recognition replay after temporary prelaunch expiry

Date: 2026-11-15. Project: `iyuryuhaylhisjfcrwkz` (Staging only). PR #359 remains draft.

## Confirmed
- Pre-change head `12bd2ec22d619eb3babeadadb8c4bc446023787a` passed all five CI workflows.
- Invoice 31 belongs to October service, was issued 2026-11-01 and has one invoice GL entry 849 in November (Dr 1200 / Cr 2200, 2471.50), and exactly one service-recognition GL entry 867 in October (Dr 2200 / Cr 4100, 2471.50). The issued vs earned periods are intentionally separate; they are not duplicated 4100 revenue.
- Opening batch 19 (GL 168) is explicitly reversed by 890 in November. No independent reviewed opening evidence exists, so financial certification remains **NOT_CERTIFIED**.
- Root defect found: opening/prelaunch authorization in `powerhub_financial_gl_recognize_billed_service` ran before the immutable replay branch. The Staging-only bootstrap expires on 2026-11-30; a legitimate retry could be rejected after expiry.
- Exact Staging migration logged: `20261115190409_powerhub_financial_d34_service_replay_after_prelaunch_expiry`. It moves the original opening/bootstrap guard after the exact immutable replay check, before period lock and any new GL INSERT. Retains actor authorization, source fingerprint, period allocations, same idempotency key, exact 2200/4100 lines, and service-only ACL.
- Installed function introspection shows immutable replay is now before opening guard. Installed rollback test `D34_INSTALLED_SERVICE_REPLAY_CUTOFF_ACL_ROLLBACK_PASS` succeeded; financial baseline 25 GL entries, 51 GL lines and 361009 company movements unchanged.
- **Limitation:** Actual post-expiry runtime behavior was not tested. Trying to expire the bootstrap inside a rollback transaction was rejected by the designed immutable `GL_PRELAUNCH_TECHNICAL_BOOTSTRAP_IMMUTABLE` trigger. That guard was **not disabled**. We do not assert post-expiry E2E success.
- The test RPC uses `SELECT FOR SHARE`, so acceptance test needs a writable transaction with `ROLLBACK`, not `BEGIN READ ONLY`.
- Existing `D32` and `D33` SQL passed in the prior phase. After this commit, five CI runs must pass on this new head. No change to Production and no merge.
- D final certification remains blocked on opening evidence, independent cross-site transfer/source proof, browser HTTPS acceptance and load/race evidence. Correct function replay is one engineering gate, not a business approval.
