import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const script=()=>readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
const runner=()=>readFileSync('scripts/pr359-shadow/run.sh','utf8');
test('Staging only, guard and bounded exported snapshot owner',()=>{
 const s=script();
 for(const fragment of ['SHADOW_SOURCE_KIND:-','SHADOW_REQUIRE_SESSION_POOLER:-','guard.mjs','coproc SNAPSHOT_KEEPER','pg_export_snapshot()','read -r -t 45 snapshot','trap cleanup EXIT',"SET LOCAL idle_in_transaction_session_timeout = '20min';","SET LOCAL transaction_timeout = '40min';"]) assert.ok(s.includes(fragment),fragment);
});
test('all four data/schema/history files share one exported snapshot',()=>{
 const s=script();
 for(const fragment of ['--snapshot="$PR359_SNAPSHOT_ID"','dump_schema schema.sql','dump_data data.sql','dump_schema history-schema.sql','dump_data history-data.sql','--schema=supabase_migrations','schema_exclude_args+=("--exclude-schema=$pattern")','data_exclude_args+=("--exclude-schema=$pattern")','postgres:17.6','--role postgres']) assert.ok(s.includes(fragment),fragment);
});
test('source reference attestations use imported transaction snapshot and manifest',()=>{
 const s=script();
 for(const fragment of ['SET TRANSACTION SNAPSHOT','source-counts','source-history-attestation.json','staging-tables-source.jsonl','staging-content-source.jsonl','staging-content-after-export.jsonl','sha256sum -c --status','PR359_STAGING_INPLACE_GO=FALSE']) assert.ok(s.includes(fragment),fragment);
});
test('production code path remains independent and protected by existing CLI dumps',()=>{
 const s=runner();
 assert.match(s,/if \[\[ "\$mode" == staging-restore \]\]; then[\s\S]*staging-atomic-export\.sh/);
 for(const fragment of ['dump roles.sql --role-only','dump schema.sql','dump data.sql --data-only --use-copy','dump history-schema.sql --schema supabase_migrations','dump history-data.sql --schema supabase_migrations --data-only --use-copy']) assert.ok(s.includes(fragment));
});

test('source snapshot has finite idle and transaction limits, not an unbounded keeper',()=>{
 const s=script();
 assert.doesNotMatch(s,/SET LOCAL idle_in_transaction_session_timeout\s*=\s*0\b/);
 assert.doesNotMatch(s,/SET LOCAL transaction_timeout\s*=\s*0\b/);
 assert.ok(s.includes("SET LOCAL idle_in_transaction_session_timeout = '20min';"));
 assert.ok(s.includes("SET LOCAL transaction_timeout = '40min';"));
 const d=readFileSync('scripts/pr359-r4/staging-atomic-snapshot-disposable.sh','utf8');
 assert.ok(d.includes('PR359_SOURCE_SNAPSHOT_IDLE_TIMEOUT_NEGATIVE_PASS'));
 assert.ok(d.includes('idle_in_transaction_session_timeout'));
});

test('two independent Staging source MVCC exports and two fresh local restores are mandatory',()=>{
 const r=runner(),e=script();
 assert.ok(e.includes('staging-snapshot-token.sha256'));
 assert.ok(r.includes('second_work="$work/second-export"'));
 assert.match(r,/SOURCE_COUNTS_SQL="\$source_sql" bash scripts\/pr359-r4\/staging-atomic-export\.sh[\s\\]*"\$second_work\/dump" "\$second_work"/);
 assert.ok(r.includes('check-independent-staging-exports.mjs "$work" "$second_work"'));
 assert.ok(r.includes('restore_work="$work/second-export"'));
 assert.ok(r.includes('PR359_STAGING_TWO_INDEPENDENT_EXPORT_RESTORE_PAIRS_PASS'));
 assert.ok(!r.includes('PR359_STAGING_REAL_LEDGER_RESTORED_TWICE_PASS'));
 const restore=r.slice(r.indexOf('restore(){'),r.indexOf('\napply(){'));
 assert.ok(!restore.includes('$work/'),'restoration must not fall back to the first export');
 assert.ok(restore.includes('$restore_work/dump/schema.sql'));
 assert.ok(restore.includes('$restore_work/staging-managed-reverse-source.json'));
 assert.ok(r.includes('PR359_STAGING_ROLES_DRIFT_BETWEEN_SOURCE_EXPORTS'));
 assert.ok(r.includes('PR359_STAGING_ROLES_DRIFT_DURING_SECOND_EXPORT'));
});

test('both restore-side managed compatibility gates require this exports snapshot-scoped Realtime zero evidence',()=>{
 const r=runner();
 const helperStart=r.indexOf('check_restore_managed_compatibility(){');
 const restoreStart=r.indexOf('restore(){');
 assert.ok(helperStart>=0 && restoreStart>helperStart);
 const helper=r.slice(helperStart,restoreStart);
 const restore=r.slice(restoreStart,r.indexOf('\napply(){'));
 assert.match(helper,/\[\[ "\$mode" == staging-restore \]\]/);
 assert.match(helper,/SHADOW_SOURCE_KIND:-/);
 assert.match(helper,/\-f "\$restore_work\/staging-realtime-messages-source"/);
 assert.match(helper,/snapshot_count="\$\(cat "\$restore_work\/staging-realtime-messages-source"\)"/);
 assert.match(helper,/\[\[ "\$snapshot_count" == 0 \]\]/);
 assert.match(helper,/PR359_RESTORE_REALTIME_SNAPSHOT_ZERO_EVIDENCE_MISSING/);
 assert.match(helper,/PR359_RESTORE_REALTIME_SNAPSHOT_NONZERO_OR_MALFORMED/);
 assert.match(helper,/PR359_CONFIRMED_EMPTY_STAGING_REALTIME=true node/);
 assert.equal((restore.match(/check_restore_managed_compatibility/g)||[]).length,2,
   'both pre/post-application local restore compatibility checks must be covered');
 assert.doesNotMatch(restore,/\n  node scripts\/pr359-shadow\/check-managed-stack-compatibility\.mjs/,
   'an unguarded restore-side compatibility invocation must not remain');
 assert.ok(r.includes('restore_work="$work/second-export"'),
   'second restore uses its own independent snapshot proof');
 assert.match(helper,/else\n    node scripts\/pr359-shadow\/check-managed-stack-compatibility\.mjs/,
   'non-Staging path must stay strict without the lifecycle exception');
});
