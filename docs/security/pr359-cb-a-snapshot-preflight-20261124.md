# CB-A — Web snapshot and wire preflight

Base: 362d23d677e9e0a4e2c4d66d26833b8d80e79dbf

The runtime previously projected and persisted a snapshot before the coordinator checked its watermark. Validate the response status/entity, retained boundary, requested watermark, complete normalized rows and reading pair scope before query-cache projection. The durable sidecar also validates snapshot rows and rejects duplicate IDs. Reject malformed wire tombstones and unknown operations before normalization. Inventory catalog SQL intentionally omits site_id for items, units and suppliers; HR SQL explicitly permits null site for employee directory and payroll summaries only. Preserve these narrow exceptions while retaining tenant and branch checks. Source contracts: migrations 20261101082724 and 20261101083251.

Tests cover malformed watermarks, duplicate/foreign rows, narrow shared scopes, invalid wire changes and source ordering. CI pending. Separate query-cache and sidecar transactions are not an atomic multi-store snapshot; crash/concurrent writes and Outbox end-to-end acceptance remain open. No hosted database changes, migration, merge or deployment authorized.
