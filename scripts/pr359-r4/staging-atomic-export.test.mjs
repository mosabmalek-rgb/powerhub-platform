import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const script=()=>readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
const runner=()=>readFileSync('scripts/pr359-shadow/run.sh','utf8');
test('Staging only, guard and bounded exported snapshot owner',()=>{
 const s=script();
 for(const fragment of ['SHADOW_SOURCE_KIND:-','SHADOW_REQUIRE_SESSION_POOLER:-','guard.mjs','coproc SNAPSHOT_KEEPER','pg_export_snapshot()','read -r -t 45 snapshot','trap cleanup EXIT',"SET LOCAL idle_in_transaction_session_timeout = \\'20min\\';","SET LOCAL transaction_timeout = \\'40min\\';"]) assert.ok(s.includes(fragment),fragment);
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
