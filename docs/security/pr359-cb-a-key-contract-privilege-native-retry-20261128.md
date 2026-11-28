# CB-A parallel acceptance: operation-key contract, privilege triage and native retry (2026-11-28)

Parent `8c67a0073ff4492ac13e2d1aec715d6c084ff62d`: six workflows passed. CI jobs 140978500129 and 140978500252 attest native cross-document Web Locks, obsolete-run rejection, 293 historical source candidates, three forensic definition matches, and three gap caller attachments. This does not approve ownership or global lock ordering.

Historical migration `20261023090000_powerhub_generator_maintenance.sql` blob `dbf15c0751f908ff8677eb3a918246ef18929447` explicitly caps add_part operation keys at 150 (line 405), unlike create/assign/transition/reopen (180). Fuel-fill migration `20261104215427_powerhub_inventory_fuel_fill_as_issue.sql` blob `982f86d530db4132ceac9dec4963bdab7d2bf877` caps at 150 (line 56). Align only addPart input to 8–150 while preserving other routes and the retry helper. Historical SQL is evidence, not fresh live catalog parity. Boundary regression exercises real input schema and the retry helper.

P0 report now partitions all 296 pending identities by archived anon/authenticated execute flags, additionally listing missing historical search_path configuration. This is prioritization, not a current security finding or approval. Native fixture adds two injected cache callback failures and verifies the real durable checkpoint remains unchanged and repair is attempted again. This is not a test of the real QueryCache persistence implementation, full session switching or HTTP transaction acceptance.

No hosted changes, migration, signed ownership, global lock order or merge. New-head CI required.
