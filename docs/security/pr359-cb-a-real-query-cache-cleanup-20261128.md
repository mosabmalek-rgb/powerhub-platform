# CB-A parallel closure: native cache durability and runner cleanup
Source head: `e52c9b591a96f714814be9a7170b0f3a3068befb`. No hosted mutations or approval.

## Verified prior head
PowerHub CI run 46146102772 job 140982406505 succeeded (TypeScript, tests, build); P0 queue checkout 932299895e0c86f0d4f82993a9ac86aca4484602: 296 candidates, 293 lexical source candidates, 3 forensic matches, 0 missing initial evidence, 0 signed approvals. Historical privilege hints: anon 0, authenticated-only 34, neither client role 262, missing historical search_path 0. This is not an effective ACL or ownership approval.
Native job 140982406715 printed all six required markers, including CACHE_FAILURE_RETRY, then exited 1 on ENOTEMPTY in temporary Chromium profile cleanup. Five other workflows succeeded on source head. No overall CI pass is claimed.

## This change
Bounded fs.rm retry for transient cleanup errors; persistent errors remain fatal. Native fixture adds real QueryClient and production persistOfflineQueryForDeltaSync/hydrateOfflineQueryCache against native IndexedDB, abort after request success, old durable data and unchanged checkpoint/outbox, successful same-version retry, and reload hydration for two user identities. The new marker is required by the runner. New head CI pending; no acceptance claim before successful job. This is a local fixture, not hosted auth, actual runtime component or full live-query race acceptance.

## Next gates
Prioritize 34 historical authenticated candidates by exact signatures and effective inherited ACL, runtime callers and tenant checks; inspect non-client role indirect trigger/cron/service paths. No signed classification granted. Live-query race, true top-level tabs, session switching, global lock ordering, certified server repair version and executable CB-B remain open.
