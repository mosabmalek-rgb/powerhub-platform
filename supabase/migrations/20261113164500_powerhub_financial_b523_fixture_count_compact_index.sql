-- B5.23: exact, compact verification count index for the immutable, hash-
-- anchored Staging-only 250k synthetic financial benchmark cohort.
--
-- The B5.17 subledger reconciliation calls
-- powerhub_financial_gl_fast_staging_fixture_proof for each read. Its exact
-- tenant/site/prefix COUNT(*) previously walked ~2230 index pages (250000
-- entries) in the broad reference prefix index, introducing >1s tail cost.
--
-- This partial index maintains an exact, transactionally updated membership
-- set for that immutable Staging cohort. It does NOT replace the count with
-- a stored constant, does not bypass the manifest/hash/trigger/external-link
-- checks, and preserves the full raw-report fallback if proof becomes invalid.
-- Nonfixture and other tenants/sites are untouched. There is no RLS/ACL,
-- accounting, session, posting or certification change.
--
-- This SQL is safe to include in git migrations; apply to Staging first and
-- never promote to Production without separate release approval.
CREATE INDEX IF NOT EXISTS account_transactions_b523_fixture_count_compact_idx
  ON public.account_transactions USING btree (tenant_id, site_id)
  WHERE tenant_id = 1
    AND site_id = 1
    AND reference_no LIKE 'STG-PERF-%';
