# CB-A — native lock observation and exact gap caller evidence (2026-11-28)

Parent `9e089ffbe41cc209d3302aa87fba57bc29686242`: run 46143987822 main job 140975899984 passed TypeScript, general tests and production build. Native browser job 140975900308 failed with "missing native cross-context lock contention". The postMessage handshake does not prove the asynchronous lock service has registered the request. Replace the one-shot observation with a five-second bounded condition poll, still requiring exactly one exclusive held and pending lock for the user and no early peer acquisition. Log the last native state on failure. No fallback or skip. This is a hypothesized scheduling race, not a confirmed browser defect; rerun required.

Add a native-storage fixture for an obsolete run at the async snapshot response boundary, checking that cache callback, checkpoint and protected stores are unchanged before the cross-context repair. The identity flag is synthetic; not a real hosted session-switch test.

The successful main job logged 293/296 lexical sources, three gaps and all three SHA-matched forensic definitions (zero missing forensic evidence). Exact identities: powerhub_ensure_owner_main_site(), powerhub_mobile_touch_session(bigint,bigint,bigint,timestamp with time zone), powerhub_refresh_fuel_maintenance_delta_after_generator_name_up(). Reuse the pinned attachment audit to join two captured trigger bindings and the scoped mobile-api direct-update source hint to those precise identities. No complete runtime call graph, trigger execution or ownership approved. CI must verify this join on the new checkout.

Concurrent RPC source review: maintenance addPart uses an 8–180 character operation key at its router, fuel recordFuelFill uses 1–150, while retryRolledBackRpc currently admits nonblank keys up to 150. The maintenance 151–180 boundary requires verification against the actual SQL idempotency contract before changing retry behavior; no runtime retry policy changed in this batch. Existing router retry tests use mock transport and do not prove HTTP or global lock order.

No hosted mutations, executable canonical SQL approval or merge.
