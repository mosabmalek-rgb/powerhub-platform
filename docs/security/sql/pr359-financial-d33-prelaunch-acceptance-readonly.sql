-- D33: prelaunch Staging-scoped financial acceptance, no artificial certification.
-- Complements D31 SHA evidence and D32 write/rollback checks.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';
DO $d33$
DECLARE x jsonb;y jsonb;z jsonb;p jsonb;g jsonb;o jsonb;bad bigint;
BEGIN
IF (SELECT count(*) FROM public.financial_gl_entries)<>27
 OR (SELECT count(*) FROM public.financial_gl_lines)<>55
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 OR (SELECT count(*) FROM public.company_account_movement_operations)<>0
THEN RAISE EXCEPTION 'D33_FINANCIAL_BASELINE_DRIFT'; END IF;
IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN
('20261115174500','20261115193000','20261115230000','20261115233000'))<>4
THEN RAISE EXCEPTION 'D33_MIGRATION_MISSING'; END IF;
IF EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid IN
('public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)'::regprocedure,
 'public.powerhub_financial_company_transfer_pair_provenance(bigint,text)'::regprocedure,
 'public.powerhub_financial_cash_source_gl_chain(bigint,text)'::regprocedure,
 'public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)'::regprocedure)
 AND (f.provolatile<>'s' OR f.prosecdef)) THEN RAISE EXCEPTION 'D33_RPC_UNSAFE'; END IF;
IF EXISTS(SELECT 1 FROM (VALUES
('public.powerhub_financial_company_accounts_tenant_reconciliation(bigint,text)'),
('public.powerhub_financial_company_transfer_pair_provenance(bigint,text)'),
('public.powerhub_financial_cash_source_gl_chain(bigint,text)'),
('public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)')) AS f(fn)
WHERE has_function_privilege('anon',fn,'EXECUTE')
 OR has_function_privilege('authenticated',fn,'EXECUTE')
 OR NOT has_function_privilege('service_role',fn,'EXECUTE'))
THEN RAISE EXCEPTION 'D33_ACL_BYPASS'; END IF;
SELECT count(*) INTO bad FROM public.financial_gl_entries e
LEFT JOIN (SELECT entry_id,count(*) n,coalesce(sum(amount) FILTER(WHERE side='debit'),0) dr,
coalesce(sum(amount) FILTER(WHERE side='credit'),0) cr
FROM public.financial_gl_lines GROUP BY entry_id) l ON l.entry_id=e.id
WHERE l.n<2 OR l.dr IS DISTINCT FROM l.cr OR l.dr<=0;
IF bad<>0 THEN RAISE EXCEPTION 'D33_GL_UNBALANCED';END IF;
x:=public.powerhub_financial_company_accounts_tenant_reconciliation(9000000000001,'2026-11');
IF (x->>'openingBalanceCountedOnceUnverified')::numeric<>300000
 OR (x->>'activeSiteCount')::int<>2 OR (x->>'accountCount')::int<>3
 OR (x->>'totalMovementCount')::bigint<>111000
 OR x->>'accountingCertification'<>'NOT_CERTIFIED'
THEN RAISE EXCEPTION 'D33_OPENING_DUPLICATED: %',x;END IF;
y:=public.powerhub_financial_company_transfer_pair_provenance(9000000000001,'2026-11');
IF (y->>'transferMovementCount')::bigint<>22200
 OR (y->>'unverifiedTransferMovementCount')::bigint<>22200
 OR (y->>'transferAmountDifference')::numeric<>11100
 OR y->>'status'<>'BLOCKED_TRANSFER_PROVENANCE'
 OR y->>'accountingCertification'<>'NOT_CERTIFIED'
THEN RAISE EXCEPTION 'D33_SYNTHETIC_TRANSFERS_FALSELY_PAIRED: %',y;END IF;
z:=public.powerhub_financial_cash_source_gl_chain(1,'2026-11');
IF (z->>'verifiedSourceCashGlMovementCount')::int<>9
 OR (z->>'unverifiedSourceCashGlMovementCount')::int<>0
 OR (z->>'unlinkedNonTransferCashMovementCount')::int<>250000
 OR z->>'accountingCertification'<>'NOT_CERTIFIED'
THEN RAISE EXCEPTION 'D33_CASH_GL_DRIFT: %',z;END IF;
p:=public.powerhub_financial_d29_fixture_evidence_partition(1,'2026-11');
IF (p->>'verifiedTechnicalFixtureMovementCountForAnalysisOnly')::int<>250000
 OR p->>'technicalPartitionAuthorizesAccountingExclusion'<>'false'
 OR p->>'accountingCertification'<>'NOT_CERTIFIED'
THEN RAISE EXCEPTION 'D33_FIXTURE_EXCLUSION_UNSAFE: %',p;END IF;
g:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
IF g->>'status'<>'MATCHED_NUMERICALLY_NOT_CERTIFIED'
 OR (g->>'differenceCount')::int<>0 OR (g->>'unresolvedCount')::int<>0
 OR g->>'accountingCertification'<>'NOT_CERTIFIED'
THEN RAISE EXCEPTION 'D33_SUBLEDGER_MISMATCH: %',g;END IF;
o:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
IF o->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
 OR o->>'allLinesAttested'<>'false'
THEN RAISE EXCEPTION 'D33_FALSE_OPENING_APPROVAL: %',o;END IF;
END $d33$;
ROLLBACK;
SELECT 'D33_STAGING_PRELAUNCH_FINANCIAL_GATES_SCOPED_PASS_BLOCKERS_PRESERVED' result;