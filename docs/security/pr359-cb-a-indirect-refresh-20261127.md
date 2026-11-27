# CB-A.5 — indirect refresh source characterization (2026-11-27)

Parent c8f7c4c0214b2a70631085359b0474f066f23d0f: six CI gates passed. Docker run 46040835213 smoke job 140647863207 logged candidate same-scope commit order, rollback cursor reuse, distinct-scope/rejection and disposable database removal PASS. Finance job 140647863447 passed.

New test uses SHA-pinned migration blob eae2c292c74b9ad71550395e904a57ab7fd79141, eight exact function definitions (indirect refreshers, Snapshot/Pull) and five triggers extracted with unique anchors. It reuses the already generated full-projector/candidate Append setup in a new rolled-back transaction. Source tables and membership refreshers remain synthetic; no claim that the current hosted catalog matches the source. The test requires explicit characterization markers, not approval of the observed gaps.

Expected evidence: 501 fuel events, 201 orders; top-500/200 with newest unrelated row and oldest affected row outside window; 499/199 generator rename updates matching the Snapshot. Two warehouse triggers each refresh both parts of one visible parent (four events, including two for an unaffected warehouse). Historical parent remains valid for Snapshot/Pull, but warehouse rename and item rename do not advance its part cursor, while Snapshot payload changes. Item updates span only the correct tenant's sites, supplier refresh remains bounded, no-op rename changes no scope state. The exact count and markers must be verified from new CI logs.

Do not equate characterization PASS with a fixed defect. Need archived/live catalog reconciliation, client historical-cache lifecycle and an independently tested candidate correction. No hosted mutation, migration, canonical signoff or merge.
